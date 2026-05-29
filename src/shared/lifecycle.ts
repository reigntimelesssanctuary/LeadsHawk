/**
 * v1.16.0 — opportunity lifecycle event log + derived state.
 *
 * Architecture: the `opportunity_events` table is the source of truth. The
 * `opportunity_state_cache` row for each opportunity is a projection of
 * that log produced by `projectOpportunityState` below. Current stage,
 * close value, cycle days, etc. all derive from replaying events.
 *
 * v1.16 only captures events. v1.17 will read them to compute
 * `learning_signals` (close rates per dimension) and feed those into
 * Stage 2 qualification. The schema design is deliberately
 * forward-compatible: tenant_id everywhere, embeddings on outcome events,
 * provenance on every row.
 *
 * All exported functions are PURE and have byte-identical copies in
 * scripts/smoke-perplexity.mjs.
 */

export type EventType =
  | 'created'         // auto-emitted by the scanner when an opportunity row is inserted
  | 'delivered'       // user/AE took ownership (sent to Slack, written brief, etc.)
  | 'accepted'        // AE thinks this is real, moves into working pipeline
  | 'rejected'        // AE bounces it back at the qualify gate — captures rejection_reason
  | 'engaged'         // prospect responded (reply / meeting / demo)
  | 'proposal_sent'   // quote is out
  | 'closed_won'      // deal closed favourably — captures amount + primary_factor
  | 'closed_lost'     // deal lost — captures close_lost_reason + competitor
  | 'archived'        // removed from pipeline without explicit close
  | 'reopened';       // reverses a prior close (or archive); prior close stays in history

export type ActorKind = 'user' | 'system' | 'llm';

export type LifecycleStage =
  | 'created'
  | 'delivered'
  | 'accepted'
  | 'rejected'
  | 'engaged'
  | 'proposal_sent'
  | 'closed_won'
  | 'closed_lost'
  | 'archived';

export type OpportunityEvent = {
  id: number;
  tenant_id: number;
  opportunity_id: number;
  event_type: EventType;
  payload_json: string | null;
  occurred_at: string;
  recorded_at: string;
  actor_kind: ActorKind;
  actor_id: string | null;
  provenance: string | null;
  embedding: string | null;
};

export type ProjectedState = {
  current_stage: LifecycleStage;
  delivered_at: string | null;
  accepted_at: string | null;
  closed_at: string | null;
  close_value: number | null;
  close_currency: string | null;
  cycle_days: number | null;
  primary_factor: string | null;
  is_closed_won: boolean;
  is_closed_lost: boolean;
  // The id of the close_won/closed_lost event currently authoritative for
  // learning. NULL when the opportunity is open (including after reopen).
  // Reopen-then-close-again semantics: the latest close event wins; older
  // closes stay in the event log for audit but don't drive learning.
  effective_close_event_id: number | null;
  last_event_id: number;
  last_event_at: string;
};

// ────────────────────────────────────────────────────────────────────────
// Controlled vocabularies (decide 4 + decide 5 from v1.16 design pass)
// ────────────────────────────────────────────────────────────────────────

export const REJECTION_REASONS = [
  { code: 'not_icp_fit',  label: 'Not ICP fit' },
  { code: 'wrong_industry', label: 'Wrong industry' },
  { code: 'too_small',    label: 'Company too small' },
  { code: 'too_large',    label: 'Company too large' },
  { code: 'bad_timing',   label: 'Bad timing' },
  { code: 'bad_data',     label: 'Bad data / hallucination' },
  { code: 'duplicate',    label: 'Already in pipeline (duplicate)' },
  { code: 'other',        label: 'Other' }
] as const;

export const CLOSE_LOST_REASONS = [
  { code: 'budget',                  label: 'No budget' },
  { code: 'timing',                  label: 'Timing mismatch' },
  { code: 'competitor_won',          label: 'Competitor won' },
  { code: 'no_decision',             label: 'No decision made' },
  { code: 'internal_priority_shift', label: 'Internal priority shift' },
  { code: 'fit_mismatch',            label: 'Product fit mismatch' },
  { code: 'champion_left',           label: 'Champion left the company' },
  { code: 'other',                   label: 'Other' }
] as const;

export const CLOSE_WON_FACTORS = [
  { code: 'compelling_event', label: 'Compelling event' },
  { code: 'relationship',     label: 'Existing relationship' },
  { code: 'product_fit',      label: 'Strong product fit' },
  { code: 'price',            label: 'Price advantage' },
  { code: 'urgency',          label: 'Urgency / deadline' },
  { code: 'other',            label: 'Other' }
] as const;

export const ENGAGEMENT_TYPES = [
  { code: 'reply',           label: 'Reply received' },
  { code: 'meeting_booked',  label: 'Meeting booked' },
  { code: 'demo_completed',  label: 'Demo completed' }
] as const;

export type RejectionReasonCode = typeof REJECTION_REASONS[number]['code'];
export type CloseLostReasonCode = typeof CLOSE_LOST_REASONS[number]['code'];
export type CloseWonFactorCode = typeof CLOSE_WON_FACTORS[number]['code'];
export type EngagementTypeCode = typeof ENGAGEMENT_TYPES[number]['code'];

// ────────────────────────────────────────────────────────────────────────
// projectOpportunityState — replays the event log to derive current state.
// THE single canonical reducer. Used by main to populate the state cache,
// and by the renderer to render lifecycle widgets without round-tripping
// through the DB.
//
// Reopen semantics (per Decide 4):
//   - A `reopened` event reverts current state to its working position
//     (accepted if there was ever an accepted, otherwise delivered) and
//     clears close_value/closed_at/primary_factor from the derived state.
//   - The prior closed_won / closed_lost event STAYS in the log.
//   - If a subsequent close_won / closed_lost lands, it overrides the
//     previous one for learning (effective_close_event_id moves forward).
// ────────────────────────────────────────────────────────────────────────

export function projectOpportunityState(events: OpportunityEvent[]): ProjectedState | null {
  if (events.length === 0) return null;

  // Sort by occurred_at; tiebreak by id so simultaneous events resolve
  // by insertion order. Stable across rebuilds.
  const sorted = [...events].sort((a, b) => {
    const t = (a.occurred_at || '').localeCompare(b.occurred_at || '');
    return t !== 0 ? t : a.id - b.id;
  });

  let stage: LifecycleStage = 'created';
  let delivered_at: string | null = null;
  let accepted_at: string | null = null;
  let closed_at: string | null = null;
  let close_value: number | null = null;
  let close_currency: string | null = null;
  let primary_factor: string | null = null;
  let is_closed_won = false;
  let is_closed_lost = false;
  let effective_close_event_id: number | null = null;

  for (const event of sorted) {
    const payload = parsePayload(event.payload_json);
    switch (event.event_type) {
      case 'created':
        stage = 'created';
        break;

      case 'delivered':
        stage = 'delivered';
        // Only set delivered_at the FIRST time. Reopens shouldn't reset
        // the original delivery timestamp.
        if (!delivered_at) delivered_at = event.occurred_at;
        break;

      case 'accepted':
        stage = 'accepted';
        if (!accepted_at) accepted_at = event.occurred_at;
        // accepted-after-close acts like an implicit reopen; clear close
        // state so the derived view matches user intent.
        is_closed_won = false;
        is_closed_lost = false;
        close_value = null;
        close_currency = null;
        primary_factor = null;
        closed_at = null;
        effective_close_event_id = null;
        break;

      case 'rejected':
        stage = 'rejected';
        break;

      case 'engaged':
        stage = 'engaged';
        break;

      case 'proposal_sent':
        stage = 'proposal_sent';
        break;

      case 'closed_won':
        stage = 'closed_won';
        closed_at = event.occurred_at;
        close_value = typeof payload?.amount === 'number' ? payload.amount : null;
        close_currency = typeof payload?.currency === 'string' ? payload.currency : 'USD';
        primary_factor = typeof payload?.primary_factor === 'string' ? payload.primary_factor : null;
        is_closed_won = true;
        is_closed_lost = false;
        effective_close_event_id = event.id;
        break;

      case 'closed_lost':
        stage = 'closed_lost';
        closed_at = event.occurred_at;
        close_value = null; // lost has no realized value
        close_currency = null;
        primary_factor = typeof payload?.reason_code === 'string' ? payload.reason_code : null;
        is_closed_won = false;
        is_closed_lost = true;
        effective_close_event_id = event.id;
        break;

      case 'archived':
        stage = 'archived';
        break;

      case 'reopened':
        // Revert current state to the working stage where the user
        // implicitly continues. If ever accepted, go back to accepted;
        // otherwise back to delivered.
        if (accepted_at) {
          stage = 'accepted';
        } else if (delivered_at) {
          stage = 'delivered';
        } else {
          stage = 'created';
        }
        is_closed_won = false;
        is_closed_lost = false;
        close_value = null;
        close_currency = null;
        primary_factor = null;
        closed_at = null;
        effective_close_event_id = null;
        break;
    }
  }

  const cycle_days = computeCycleDaysFromAnchors(delivered_at, closed_at);
  const last = sorted[sorted.length - 1];

  return {
    current_stage: stage,
    delivered_at,
    accepted_at,
    closed_at,
    close_value,
    close_currency,
    cycle_days,
    primary_factor,
    is_closed_won,
    is_closed_lost,
    effective_close_event_id,
    last_event_id: last.id,
    last_event_at: last.occurred_at
  };
}

function parsePayload(json: string | null): any {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

function computeCycleDaysFromAnchors(deliveredAt: string | null, closedAt: string | null): number | null {
  if (!deliveredAt || !closedAt) return null;
  const start = Date.parse(deliveredAt);
  const end = Date.parse(closedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const days = Math.floor((end - start) / 86400000);
  return days < 0 ? 0 : days;
}

// ────────────────────────────────────────────────────────────────────────
// eventValidator — enforces the controlled-vocab requirements at the
// boundary. Returns null when valid, an error message otherwise. The IPC
// handler refuses to append invalid events.
// ────────────────────────────────────────────────────────────────────────

export function eventValidator(type: EventType, payload: any): string | null {
  switch (type) {
    case 'created':
    case 'delivered':
    case 'accepted':
    case 'archived':
    case 'reopened':
    case 'engaged':
    case 'proposal_sent':
      return null; // payload fields all optional
    case 'rejected':
      if (payload?.reason_code && !REJECTION_REASONS.some((r) => r.code === payload.reason_code)) {
        return `rejected.reason_code must be one of: ${REJECTION_REASONS.map((r) => r.code).join(', ')}`;
      }
      return null;
    case 'closed_won':
      if (payload?.amount !== undefined && payload.amount !== null) {
        if (typeof payload.amount !== 'number' || !Number.isFinite(payload.amount) || payload.amount < 0) {
          return 'closed_won.amount must be a non-negative number';
        }
      }
      if (payload?.primary_factor && !CLOSE_WON_FACTORS.some((f) => f.code === payload.primary_factor)) {
        return `closed_won.primary_factor must be one of: ${CLOSE_WON_FACTORS.map((f) => f.code).join(', ')}`;
      }
      return null;
    case 'closed_lost':
      if (!payload?.reason_code) {
        return 'closed_lost.reason_code is required for learning';
      }
      if (!CLOSE_LOST_REASONS.some((r) => r.code === payload.reason_code)) {
        return `closed_lost.reason_code must be one of: ${CLOSE_LOST_REASONS.map((r) => r.code).join(', ')}`;
      }
      return null;
    default:
      return `unknown event type: ${type}`;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Pipeline summary helpers — used by Dashboard widgets.
// ────────────────────────────────────────────────────────────────────────

export type PipelineSummary = {
  by_stage: Record<LifecycleStage, number>;
  total_opportunities: number;
  total_won: number;
  total_lost: number;
  total_won_value: number;
  avg_cycle_days: number | null;
  win_rate: number | null; // won / (won + lost), null when n < threshold
};

const MIN_DEALS_FOR_WIN_RATE = 3;

export function summarizePipeline(opportunityEvents: OpportunityEvent[][]): PipelineSummary {
  const by_stage: Record<LifecycleStage, number> = {
    created: 0, delivered: 0, accepted: 0, rejected: 0,
    engaged: 0, proposal_sent: 0, closed_won: 0, closed_lost: 0,
    archived: 0
  };
  let total_won = 0;
  let total_lost = 0;
  let total_won_value = 0;
  const cycles: number[] = [];

  for (const events of opportunityEvents) {
    const state = projectOpportunityState(events);
    if (!state) continue;
    by_stage[state.current_stage]++;
    if (state.is_closed_won) {
      total_won++;
      if (typeof state.close_value === 'number') total_won_value += state.close_value;
      if (typeof state.cycle_days === 'number') cycles.push(state.cycle_days);
    }
    if (state.is_closed_lost) {
      total_lost++;
      if (typeof state.cycle_days === 'number') cycles.push(state.cycle_days);
    }
  }

  const totalClosed = total_won + total_lost;
  const win_rate = totalClosed >= MIN_DEALS_FOR_WIN_RATE ? total_won / totalClosed : null;
  const avg_cycle_days = cycles.length > 0
    ? cycles.reduce((a, b) => a + b, 0) / cycles.length
    : null;

  return {
    by_stage,
    total_opportunities: opportunityEvents.length,
    total_won,
    total_lost,
    total_won_value,
    avg_cycle_days,
    win_rate
  };
}

// ────────────────────────────────────────────────────────────────────────
// isStale — surfaces opportunities that have sat in a working stage
// (delivered/accepted/engaged/proposal_sent) without any new event for
// `thresholdDays`. Used by the Dashboard "Stale" filter + warning chip.
// ────────────────────────────────────────────────────────────────────────

export function isStale(
  events: OpportunityEvent[],
  thresholdDays: number,
  nowIso: string
): boolean {
  const state = projectOpportunityState(events);
  if (!state) return false;
  const workingStages: LifecycleStage[] = ['delivered', 'accepted', 'engaged', 'proposal_sent'];
  if (!workingStages.includes(state.current_stage)) return false;
  const now = Date.parse(nowIso);
  const last = Date.parse(state.last_event_at);
  if (Number.isNaN(now) || Number.isNaN(last)) return false;
  const ageMs = now - last;
  return ageMs > thresholdDays * 86400000;
}

// ────────────────────────────────────────────────────────────────────────
// timeDecayWeight — exponential decay used by v1.17 learning. Older
// outcomes contribute less to the close-rate per dimension. Lives here
// because (a) it's pure and smoke-testable, (b) the renderer's "Learning
// status" panel will display the effective weight per dimension once
// v1.17 ships.
//
//   weight(age) = 0.5 ^ (ageDays / halfLifeDays)
//
// halfLifeDays=180 (6 months) is a reasonable default for B2B sales
// cycles — outcomes from 6 months ago carry half the weight of brand-new
// outcomes. v1.17 will surface this as a tunable setting.
// ────────────────────────────────────────────────────────────────────────

export function timeDecayWeight(occurredAt: string, halfLifeDays: number, nowIso: string): number {
  const occurred = Date.parse(occurredAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(occurred) || Number.isNaN(now) || halfLifeDays <= 0) return 1;
  const ageDays = Math.max(0, (now - occurred) / 86400000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

// ────────────────────────────────────────────────────────────────────────
// Convenience: legacy status mapping. The opportunities.status column
// (open/qualified/disqualified/archived) predates the event log. v1.16
// keeps it in sync with the projected stage for back-compat with existing
// UI that reads .status directly. Maps follow:
//   created, delivered, reopened-back-to-delivered                → open
//   accepted, engaged, proposal_sent, closed_won                  → qualified
//   rejected, closed_lost                                          → disqualified
//   archived                                                       → archived
// ────────────────────────────────────────────────────────────────────────

export function stageToLegacyStatus(stage: LifecycleStage): 'open' | 'qualified' | 'disqualified' | 'archived' {
  switch (stage) {
    case 'accepted':
    case 'engaged':
    case 'proposal_sent':
    case 'closed_won':
      return 'qualified';
    case 'rejected':
    case 'closed_lost':
      return 'disqualified';
    case 'archived':
      return 'archived';
    default:
      return 'open';
  }
}

// Human-readable stage labels for UI.
export function stageLabel(stage: LifecycleStage): string {
  switch (stage) {
    case 'created':       return 'New';
    case 'delivered':     return 'Delivered';
    case 'accepted':      return 'Working';
    case 'rejected':      return 'Rejected';
    case 'engaged':       return 'Engaged';
    case 'proposal_sent': return 'Proposal sent';
    case 'closed_won':    return 'Closed-won';
    case 'closed_lost':   return 'Closed-lost';
    case 'archived':      return 'Archived';
  }
}
