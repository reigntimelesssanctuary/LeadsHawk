import { useEffect, useState } from 'react';
import type {
  Opportunity, Brand, Product, ContactWithDraft, ContactDraft
} from '../../../shared/types';
import {
  REJECTION_REASONS,
  CLOSE_LOST_REASONS,
  CLOSE_WON_FACTORS,
  ENGAGEMENT_TYPES,
  stageLabel,
  type EventType,
  type LifecycleStage,
  type OpportunityEvent
} from '../../../shared/lifecycle';
import { fmtDate, openExternal } from '../lib/api';
import {
  ArrowLeft, Sparkles, CheckCircle2, XCircle, Archive as ArchiveIcon, ExternalLink,
  Send, MessageCircle, FileText, Trophy, TrendingDown, RotateCcw, ChevronDown, Clock,
  Users, Copy, Edit2, RefreshCw, Brain, SkipForward, Check
} from 'lucide-react';

type StateRow = {
  current_stage: LifecycleStage;
  delivered_at: string | null;
  accepted_at: string | null;
  closed_at: string | null;
  close_value: number | null;
  close_currency: string | null;
  cycle_days: number | null;
  primary_factor: string | null;
  is_closed_won: number;
  is_closed_lost: number;
};

type ModalMode =
  | { kind: 'rejected' }
  | { kind: 'engaged' }
  | { kind: 'proposal_sent' }
  | { kind: 'closed_won' }
  | { kind: 'closed_lost' }
  | { kind: 'delivered' };

const STAGE_CHIP_STYLES: Record<LifecycleStage, { bg: string; fg: string }> = {
  created:       { bg: '#f3f4f6', fg: '#4b5563' },
  delivered:     { bg: '#e0e7ff', fg: '#3730a3' },
  accepted:      { bg: '#fef3c7', fg: '#92400e' },
  rejected:      { bg: '#fee2e2', fg: '#991b1b' },
  engaged:       { bg: '#cffafe', fg: '#155e75' },
  proposal_sent: { bg: '#ede9fe', fg: '#5b21b6' },
  closed_won:    { bg: '#d1fae5', fg: '#065f46' },
  closed_lost:   { bg: '#fee2e2', fg: '#991b1b' },
  archived:      { bg: '#e0e7ff', fg: '#3730a3' }
};

export function OpportunityDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const [opp, setOpp] = useState<Opportunity | null>(null);
  const [brand, setBrand] = useState<Brand | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [state, setState] = useState<StateRow | null>(null);
  const [events, setEvents] = useState<OpportunityEvent[]>([]);
  const [brief, setBrief] = useState<string>('');
  const [generating, setGenerating] = useState(false);
  const [modal, setModal] = useState<ModalMode | null>(null);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);

  const refresh = async () => {
    const o = await window.lh.opps.get(id);
    setOpp(o);
    setBrand(o.brand_id ? await window.lh.brands.get(o.brand_id) : null);
    setProduct(o.product_id ? await window.lh.products.get(o.product_id) : null);
    const [s, evs] = await Promise.all([
      window.lh.opps.state(id),
      window.lh.events.list(id)
    ]);
    setState(s);
    setEvents(evs);
  };
  useEffect(() => { refresh(); }, [id]);

  if (!opp) return <div style={{ padding: 24, color: '#6b7280' }}>Loading…</div>;

  const appendEvent = async (type: EventType, payload?: any) => {
    try {
      await window.lh.events.append(id, type, payload);
      await refresh();
    } catch (e: any) {
      alert(`Failed to record event: ${e?.message || e}`);
    }
  };

  const currentStage: LifecycleStage = (state?.current_stage as LifecycleStage) || 'created';
  const stageChip = STAGE_CHIP_STYLES[currentStage];
  const isClosed = currentStage === 'closed_won' || currentStage === 'closed_lost' || currentStage === 'archived';
  const isRejected = currentStage === 'rejected';
  const isWorking = currentStage === 'accepted' || currentStage === 'engaged' || currentStage === 'proposal_sent';

  // Primary actions adapt to current stage so the most likely next-step
  // sits where the eye lands first.
  const primaryActions = (() => {
    if (currentStage === 'created' || currentStage === 'delivered') {
      return (
        <>
          <button
            className="btn-primary"
            onClick={() => appendEvent('accepted')}
            title="AE will pursue this lead"
          >
            <CheckCircle2 size={14} style={{ display: 'inline', marginRight: 4 }} /> Accept
          </button>
          <button
            className="btn-ghost"
            onClick={() => setModal({ kind: 'rejected' })}
            title="Bounce back at the qualify gate — captures the reason for learning"
          >
            <XCircle size={14} style={{ display: 'inline', marginRight: 4 }} /> Reject
          </button>
        </>
      );
    }
    if (isWorking) {
      return (
        <>
          <button className="btn-primary" onClick={() => setModal({ kind: 'closed_won' })}>
            <Trophy size={14} style={{ display: 'inline', marginRight: 4 }} /> Closed-won
          </button>
          <button className="btn-ghost" onClick={() => setModal({ kind: 'closed_lost' })}>
            <TrendingDown size={14} style={{ display: 'inline', marginRight: 4 }} /> Closed-lost
          </button>
        </>
      );
    }
    if (isClosed || isRejected) {
      return (
        <button
          className="btn-primary"
          onClick={() => appendEvent('reopened', { note: 'Reopened from Opportunity Detail' })}
        >
          <RotateCcw size={14} style={{ display: 'inline', marginRight: 4 }} /> Reopen
        </button>
      );
    }
    return null;
  })();

  const generateBrief = async () => {
    setGenerating(true);
    try {
      const out = await window.lh.opps.brief(id);
      setBrief(out);
    } catch (e: any) { alert(e.message); }
    finally { setGenerating(false); }
  };

  return (
    <div>
      <div style={{ marginTop: 16, marginBottom: 16 }}>
        <button className="btn-ghost" onClick={onClose}>
          <ArrowLeft size={14} style={{ display: 'inline', marginRight: 4 }} /> Back
        </button>
      </div>

      <div className="card" style={{ padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 300 }}>
            <div style={{ color: '#6b7280', fontSize: 13 }}>{opp.industry || ''}</div>
            <div className="h-page" style={{ marginTop: 4 }}>{opp.company}</div>
            <div style={{ marginTop: 12, color: '#1f2937', fontSize: 15 }}>{opp.signal_summary}</div>
            <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {brand && <span className="chip chip-brand">{brand.name}</span>}
              {product && <span className="chip chip-muted">{product.name}</span>}
              <span
                className="chip"
                style={{ background: stageChip.bg, color: stageChip.fg, fontWeight: 600 }}
                title={`Lifecycle stage: ${stageLabel(currentStage)}`}
              >
                {stageLabel(currentStage)}
              </span>
              <span className="chip chip-muted">{Math.round((opp.confidence || 0) * 100)}% confidence</span>
              {state?.close_value !== null && state?.close_value !== undefined && state.is_closed_won === 1 && (
                <span className="chip chip-qualified">
                  ${state.close_value.toLocaleString()} {state.close_currency || 'USD'}
                </span>
              )}
              {state?.cycle_days !== null && state?.cycle_days !== undefined && (
                <span className="chip chip-muted" title="Days from delivered to closed">
                  {state.cycle_days}d cycle
                </span>
              )}
            </div>
            {opp.status === 'disqualified' && opp.disqualify_reason && currentStage !== 'rejected' && currentStage !== 'closed_lost' && (
              <div style={{ marginTop: 12, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 13, color: '#991b1b' }}>
                <span style={{ fontWeight: 600 }}>Legacy disqualify note:</span> {opp.disqualify_reason}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {primaryActions}
            {/* Secondary "Mark…" dropdown with the less-common transitions */}
            <div style={{ position: 'relative' }}>
              <button className="btn-ghost" onClick={() => setMoreMenuOpen(!moreMenuOpen)}>
                Mark… <ChevronDown size={13} style={{ display: 'inline', marginLeft: 2, verticalAlign: '-2px' }} />
              </button>
              {moreMenuOpen && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    right: 0,
                    marginTop: 4,
                    background: 'white',
                    border: '1px solid #e5e7eb',
                    borderRadius: 8,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
                    minWidth: 200,
                    zIndex: 10
                  }}
                  onMouseLeave={() => setMoreMenuOpen(false)}
                >
                  <MenuItem icon={<Send size={13} />}        label="Delivered to AE" onClick={() => { setMoreMenuOpen(false); setModal({ kind: 'delivered' }); }} />
                  <MenuItem icon={<MessageCircle size={13} />} label="Prospect engaged"  onClick={() => { setMoreMenuOpen(false); setModal({ kind: 'engaged' }); }} />
                  <MenuItem icon={<FileText size={13} />}    label="Proposal sent"     onClick={() => { setMoreMenuOpen(false); setModal({ kind: 'proposal_sent' }); }} />
                  {!isClosed && !isRejected && (
                    <>
                      <Divider />
                      <MenuItem icon={<Trophy size={13} />}        label="Closed-won…"   onClick={() => { setMoreMenuOpen(false); setModal({ kind: 'closed_won' }); }} />
                      <MenuItem icon={<TrendingDown size={13} />}  label="Closed-lost…"  onClick={() => { setMoreMenuOpen(false); setModal({ kind: 'closed_lost' }); }} />
                    </>
                  )}
                  <Divider />
                  <MenuItem
                    icon={<ArchiveIcon size={13} />}
                    label="Archive"
                    onClick={() => { setMoreMenuOpen(false); appendEvent('archived'); }}
                  />
                  {(isClosed || isRejected) && (
                    <MenuItem
                      icon={<RotateCcw size={13} />}
                      label="Reopen"
                      onClick={() => { setMoreMenuOpen(false); appendEvent('reopened', { note: 'Reopened from menu' }); }}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <Section title="Background">{opp.background}</Section>
        <Section title="Justified use case">{opp.use_case}</Section>
        <Section title="Recommended sales angle">{opp.angle}</Section>
        <Section title="Source">
          <div style={{ fontSize: 14 }}>
            <div style={{ fontWeight: 500 }}>{opp.headline}</div>
            <div style={{ color: '#6b7280', fontSize: 13, marginTop: 4 }}>
              {opp.source_title} {opp.source_published_at && '· ' + fmtDate(opp.source_published_at)}
            </div>
            <button className="btn-ghost" style={{ marginTop: 10 }} onClick={() => openExternal(opp.source_url)}>
              <ExternalLink size={13} style={{ display: 'inline', marginRight: 4 }} /> Open source
            </button>
            <AlternativeSources rawSignal={opp.raw_signal} />
          </div>
        </Section>
      </div>

      {/* v1.19.0: Hunt list — Apollo contacts + per-contact drafts. */}
      <HuntListSection oppId={id} opp={opp} />

      {/* v1.16.0: lifecycle event timeline */}
      <div className="card" style={{ padding: 20, marginTop: 16 }}>
        <div className="h-section" style={{ marginBottom: 12 }}>
          <Clock size={16} style={{ display: 'inline', marginRight: 8, verticalAlign: '-2px', color: '#6b7280' }} />
          Lifecycle history
        </div>
        <EventTimeline events={events} />
      </div>

      <div className="card" style={{ padding: 20, marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="h-section">Sales brief</div>
          <button className="btn-primary" onClick={generateBrief} disabled={generating}>
            <Sparkles size={14} style={{ display: 'inline', marginRight: 6 }} />
            {generating ? 'Generating…' : (brief ? 'Regenerate' : 'Generate brief')}
          </button>
        </div>
        {brief && (
          <div className="prose-output" style={{ marginTop: 16 }}>{brief}</div>
        )}
      </div>

      {modal && (
        <LifecycleModal
          mode={modal}
          onCancel={() => setModal(null)}
          onSubmit={async (type, payload) => {
            setModal(null);
            await appendEvent(type, payload);
          }}
        />
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        padding: '8px 12px',
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        fontSize: 13,
        color: '#1f2937'
      }}
      onMouseEnter={(e) => (e.currentTarget as HTMLButtonElement).style.background = '#f9fafb'}
      onMouseLeave={(e) => (e.currentTarget as HTMLButtonElement).style.background = 'transparent'}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Divider() {
  return <div style={{ height: 1, background: '#e5e7eb', margin: '4px 0' }} />;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: 18 }}>
      <div className="label" style={{ marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 14, color: '#1f2937', whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{children || '—'}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Event timeline — chronological list of lifecycle events with stage chip
// + payload summary for each.
// ────────────────────────────────────────────────────────────────────────

function EventTimeline({ events }: { events: OpportunityEvent[] }) {
  if (events.length === 0) {
    return <div style={{ color: '#6b7280', fontSize: 13 }}>No events yet.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {events.map((ev) => {
        const payload = parsePayload(ev.payload_json);
        const summary = summarizeEvent(ev.event_type as EventType, payload);
        const chipStyle = stageChipForEventType(ev.event_type as EventType);
        return (
          <div
            key={ev.id}
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'flex-start',
              padding: '8px 0',
              borderBottom: '1px dashed #f3f4f6'
            }}
          >
            <div style={{ minWidth: 130, fontSize: 12, color: '#6b7280' }}>
              {fmtDate(ev.occurred_at)}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span
                  className="chip"
                  style={{ background: chipStyle.bg, color: chipStyle.fg, fontSize: 11, padding: '2px 8px' }}
                >
                  {eventLabel(ev.event_type as EventType)}
                </span>
                {ev.actor_kind === 'system' && (
                  <span style={{ fontSize: 11, color: '#9ca3af' }}>system</span>
                )}
              </div>
              {summary && (
                <div style={{ marginTop: 4, fontSize: 13, color: '#1f2937' }}>{summary}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function parsePayload(json: string | null): any {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

function eventLabel(type: EventType): string {
  switch (type) {
    case 'created':       return 'Created';
    case 'delivered':     return 'Delivered';
    case 'accepted':      return 'Accepted';
    case 'rejected':      return 'Rejected';
    case 'engaged':       return 'Engaged';
    case 'proposal_sent': return 'Proposal sent';
    case 'closed_won':    return 'Closed-won';
    case 'closed_lost':   return 'Closed-lost';
    case 'archived':      return 'Archived';
    case 'reopened':      return 'Reopened';
  }
}

function stageChipForEventType(type: EventType) {
  switch (type) {
    case 'created':       return STAGE_CHIP_STYLES.created;
    case 'delivered':     return STAGE_CHIP_STYLES.delivered;
    case 'accepted':      return STAGE_CHIP_STYLES.accepted;
    case 'rejected':      return STAGE_CHIP_STYLES.rejected;
    case 'engaged':       return STAGE_CHIP_STYLES.engaged;
    case 'proposal_sent': return STAGE_CHIP_STYLES.proposal_sent;
    case 'closed_won':    return STAGE_CHIP_STYLES.closed_won;
    case 'closed_lost':   return STAGE_CHIP_STYLES.closed_lost;
    case 'archived':      return STAGE_CHIP_STYLES.archived;
    case 'reopened':      return { bg: '#fef3c7', fg: '#92400e' };
  }
}

function summarizeEvent(type: EventType, payload: any): string {
  if (!payload) {
    if (type === 'accepted') return 'AE took it into the working pipeline.';
    if (type === 'archived') return 'Removed from pipeline without close.';
    return '';
  }
  switch (type) {
    case 'rejected': {
      const code = payload?.reason_code;
      const label = REJECTION_REASONS.find((r) => r.code === code)?.label || code || '';
      const text = payload?.reason_text;
      return [label, text].filter(Boolean).join(' — ');
    }
    case 'engaged': {
      const code = payload?.engagement_type;
      const label = ENGAGEMENT_TYPES.find((e) => e.code === code)?.label || code || '';
      return label || '';
    }
    case 'proposal_sent': {
      return typeof payload?.amount === 'number'
        ? `Quote sent — $${payload.amount.toLocaleString()}`
        : 'Quote sent.';
    }
    case 'closed_won': {
      const factor = payload?.primary_factor;
      const factorLabel = CLOSE_WON_FACTORS.find((f) => f.code === factor)?.label || factor || '';
      const amount = typeof payload?.amount === 'number'
        ? `$${payload.amount.toLocaleString()}`
        : '';
      return [amount, factorLabel].filter(Boolean).join(' · ');
    }
    case 'closed_lost': {
      const code = payload?.reason_code;
      const label = CLOSE_LOST_REASONS.find((r) => r.code === code)?.label || code || '';
      const competitor = payload?.competitor ? `vs ${payload.competitor}` : '';
      const text = payload?.reason_text;
      return [label, competitor, text].filter(Boolean).join(' — ');
    }
    case 'delivered': {
      const channel = payload?.channel;
      return channel ? `Delivered via ${channel}` : '';
    }
    case 'reopened': {
      return payload?.note || '';
    }
    default:
      return '';
  }
}

// ────────────────────────────────────────────────────────────────────────
// LifecycleModal — single component handles all event types that need a
// reason picker / amount input / free-text note.
// ────────────────────────────────────────────────────────────────────────

function LifecycleModal({
  mode, onCancel, onSubmit
}: {
  mode: ModalMode;
  onCancel: () => void;
  onSubmit: (type: EventType, payload: any) => Promise<void>;
}) {
  // Per-mode form state.
  const [reasonCode, setReasonCode] = useState<string>('');
  const [reasonText, setReasonText] = useState<string>('');
  const [amount, setAmount] = useState<string>('');
  const [factor, setFactor] = useState<string>('');
  const [engagementType, setEngagementType] = useState<string>(ENGAGEMENT_TYPES[0].code);
  const [competitor, setCompetitor] = useState<string>('');
  const [channel, setChannel] = useState<string>('manual');

  // Initialize first option for reason pickers so a submit-without-touch
  // doesn't fail validation.
  useEffect(() => {
    if (mode.kind === 'rejected' && !reasonCode) setReasonCode(REJECTION_REASONS[0].code);
    if (mode.kind === 'closed_lost' && !reasonCode) setReasonCode(CLOSE_LOST_REASONS[0].code);
  }, [mode.kind]);

  const submit = async () => {
    switch (mode.kind) {
      case 'rejected':
        await onSubmit('rejected', {
          reason_code: reasonCode || 'other',
          reason_text: reasonText || undefined
        });
        break;
      case 'engaged':
        await onSubmit('engaged', { engagement_type: engagementType });
        break;
      case 'proposal_sent': {
        const num = amount ? Number(amount) : undefined;
        await onSubmit('proposal_sent', num !== undefined ? { amount: num } : {});
        break;
      }
      case 'closed_won': {
        const num = amount ? Number(amount) : undefined;
        const payload: any = {};
        if (num !== undefined && !Number.isNaN(num)) payload.amount = num;
        if (factor) payload.primary_factor = factor;
        if (reasonText) payload.note = reasonText;
        await onSubmit('closed_won', payload);
        break;
      }
      case 'closed_lost': {
        const payload: any = { reason_code: reasonCode || 'other' };
        if (competitor) payload.competitor = competitor;
        if (reasonText) payload.reason_text = reasonText;
        await onSubmit('closed_lost', payload);
        break;
      }
      case 'delivered':
        await onSubmit('delivered', channel ? { channel } : undefined);
        break;
    }
  };

  const title = (() => {
    switch (mode.kind) {
      case 'rejected':      return 'Reject opportunity';
      case 'engaged':       return 'Mark engaged';
      case 'proposal_sent': return 'Mark proposal sent';
      case 'closed_won':    return 'Mark closed-won';
      case 'closed_lost':   return 'Mark closed-lost';
      case 'delivered':     return 'Mark delivered';
    }
  })();

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100
      }}
      onClick={onCancel}
    >
      <div
        className="card"
        style={{ padding: 24, width: 'min(520px, 90vw)', maxHeight: '90vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-section" style={{ marginBottom: 16 }}>{title}</div>

        {mode.kind === 'rejected' && (
          <>
            <label className="label">Reason</label>
            <select className="select" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              {REJECTION_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
            <div style={{ height: 12 }} />
            <label className="label">Notes (optional)</label>
            <textarea
              className="input"
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              placeholder="Anything that helps LeadsHawk learn what to filter out next time."
              style={{ minHeight: 80, resize: 'vertical' }}
            />
          </>
        )}

        {mode.kind === 'engaged' && (
          <>
            <label className="label">Engagement type</label>
            <select className="select" value={engagementType} onChange={(e) => setEngagementType(e.target.value)}>
              {ENGAGEMENT_TYPES.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
            </select>
          </>
        )}

        {mode.kind === 'proposal_sent' && (
          <>
            <label className="label">Quote amount (optional)</label>
            <input
              className="input"
              type="number" min="0" step="100"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 45000"
            />
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
              USD. Leave blank if not yet known.
            </div>
          </>
        )}

        {mode.kind === 'closed_won' && (
          <>
            <label className="label">Deal value (optional)</label>
            <input
              className="input"
              type="number" min="0" step="100"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 48000"
            />
            <div style={{ height: 12 }} />
            <label className="label">Primary factor that closed this (optional)</label>
            <select className="select" value={factor} onChange={(e) => setFactor(e.target.value)}>
              <option value="">— pick one —</option>
              {CLOSE_WON_FACTORS.map((f) => <option key={f.code} value={f.code}>{f.label}</option>)}
            </select>
            <div style={{ height: 12 }} />
            <label className="label">Notes (optional)</label>
            <textarea
              className="input"
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              placeholder="What worked? Anything to remember for next time."
              style={{ minHeight: 60, resize: 'vertical' }}
            />
          </>
        )}

        {mode.kind === 'closed_lost' && (
          <>
            <label className="label">Reason</label>
            <select className="select" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              {CLOSE_LOST_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
            <div style={{ height: 12 }} />
            <label className="label">Competitor (optional)</label>
            <input
              className="input"
              value={competitor}
              onChange={(e) => setCompetitor(e.target.value)}
              placeholder="e.g. CompetitorX"
            />
            <div style={{ height: 12 }} />
            <label className="label">Notes (optional)</label>
            <textarea
              className="input"
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              placeholder="Anything that helps explain why we lost."
              style={{ minHeight: 60, resize: 'vertical' }}
            />
          </>
        )}

        {mode.kind === 'delivered' && (
          <>
            <label className="label">Channel (optional)</label>
            <select className="select" value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="manual">Manual (I handed it off myself)</option>
              <option value="slack">Slack</option>
              <option value="email">Email</option>
              <option value="crm">CRM</option>
            </select>
          </>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn-primary" onClick={submit}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// v1.19.0 — Hunt list section. Apollo contact discovery + per-contact
// Opus drafts. Manual trigger; the operator drives every step.
// ────────────────────────────────────────────────────────────────────────

function HuntListSection({ oppId, opp }: { oppId: number; opp: Opportunity }) {
  const [contacts, setContacts] = useState<ContactWithDraft[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const list = await window.lh.contacts.listForOpp(oppId);
      setContacts(list);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };
  useEffect(() => { load(); }, [oppId]);

  const doSearch = async (isRehunt: boolean) => {
    if (isRehunt && contacts && contacts.length > 0) {
      const pending = contacts.filter((c) => c.contact_status === 'pending').length;
      const preserved = contacts.length - pending;
      const ok = confirm(
        `Re-searching will:\n` +
        `  • Keep ${preserved} contact(s) in non-pending state (drafted/sent/skipped)\n` +
        `  • Replace ${pending} pending contact(s) with up to 5 fresh ones\n\n` +
        `Continue?`
      );
      if (!ok) return;
    }
    setSearching(true);
    setError(null);
    try {
      const r = await window.lh.contacts.search(oppId);
      if (r.status === 'search_failed') {
        setError(r.error || 'Search failed.');
      } else if (r.status === 'no_contacts') {
        setError('Apollo did not surface ≥3 usable contacts. Try refining the dossier or retrying later.');
      }
      await load();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="card" style={{ padding: 20, marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div className="h-section">
          <Users size={16} style={{ display: 'inline', marginRight: 8, verticalAlign: '-2px', color: '#6b7280' }} />
          Hunt list
          {contacts && contacts.length > 0 && (
            <span style={{ marginLeft: 10, fontSize: 13, fontWeight: 500, color: '#6b7280' }}>
              {contacts.length} contact{contacts.length === 1 ? '' : 's'} ranked
            </span>
          )}
        </div>
        {contacts && contacts.length > 0 && (
          <button className="btn-ghost" onClick={() => doSearch(true)} disabled={searching}>
            <RefreshCw size={13} style={{ display: 'inline', marginRight: 6, verticalAlign: '-2px' }} />
            {searching ? 'Searching…' : 'Re-search'}
          </button>
        )}
      </div>

      {/* Pre-search empty state */}
      {contacts !== null && contacts.length === 0 && (
        <div style={{ padding: '24px 8px', textAlign: 'center' }}>
          <div style={{ color: '#6b7280', fontSize: 13, marginBottom: 16 }}>
            No contacts searched yet. Click below to look up 3-5 contacts at{' '}
            <b>{opp.company}</b> via Apollo and rank them by fit.
          </div>
          <button className="btn-primary" onClick={() => doSearch(false)} disabled={searching}>
            <Users size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: '-2px' }} />
            {searching ? 'Searching…' : 'Search contacts'}
          </button>
          <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 10 }}>
            Estimated cost: ~3-5 Apollo credits + ~$0.01 Claude (archetype reasoning).
          </div>
        </div>
      )}

      {error && (
        <div style={{
          padding: '10px 14px',
          background: '#fef2f2',
          border: '1px solid #fecaca',
          borderRadius: 6,
          fontSize: 13,
          color: '#991b1b',
          marginBottom: 12
        }}>
          {error}
        </div>
      )}

      {/* Post-search contact list */}
      {contacts && contacts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {contacts.map((c) => (
            <ContactCard
              key={c.id}
              contact={c}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ContactCard({
  contact, onChanged
}: {
  contact: ContactWithDraft;
  onChanged: () => Promise<void>;
}) {
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [showWhy, setShowWhy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [editing, setEditing] = useState(false);
  const [editSubject, setEditSubject] = useState('');
  const [editBody, setEditBody] = useState('');
  const [versions, setVersions] = useState<ContactDraft[] | null>(null);
  const [copyHint, setCopyHint] = useState(false);

  const isSkipped = contact.contact_status === 'skipped';
  const isSent = contact.contact_status === 'sent';
  const active = contact.active_draft;

  const generateDraft = async (withFeedback: boolean) => {
    setDrafting(true);
    setDraftError(null);
    try {
      await window.lh.contacts.draftEmail(contact.id, withFeedback ? { feedback } : undefined);
      setFeedback('');
      await onChanged();
      setVersions(null);
    } catch (e: any) {
      setDraftError(e?.message || String(e));
    } finally {
      setDrafting(false);
    }
  };

  const loadVersions = async () => {
    const v = await window.lh.contacts.listDrafts(contact.id);
    setVersions(v);
  };

  const switchVersion = async (draftId: number) => {
    await window.lh.contacts.setActiveDraft(contact.id, draftId);
    await onChanged();
    await loadVersions();
  };

  const saveEdit = async () => {
    if (!active) return;
    await window.lh.contacts.updateDraft(active.id, editSubject, editBody);
    setEditing(false);
    await onChanged();
  };

  const startEdit = () => {
    if (!active) return;
    setEditSubject(active.subject);
    setEditBody(active.body);
    setEditing(true);
  };

  const copyDraft = async () => {
    if (!active) return;
    const text = `Subject: ${active.subject}\n\n${active.body}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopyHint(true);
      setTimeout(() => setCopyHint(false), 1800);
    } catch {
      alert('Clipboard copy failed. Select-and-copy manually.');
    }
  };

  const markSent = async () => {
    await window.lh.contacts.markSent(contact.id);
    await onChanged();
  };

  const skip = async () => {
    await window.lh.contacts.skip(contact.id);
    await onChanged();
  };

  const unskip = async () => {
    await window.lh.contacts.unskip(contact.id);
    await onChanged();
  };

  const rankComponents = (() => {
    if (!contact.rank_components) return null;
    try { return JSON.parse(contact.rank_components); } catch { return null; }
  })();

  return (
    <div
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 10,
        padding: 14,
        opacity: isSkipped ? 0.55 : 1
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600 }}>#{contact.hunt_rank}</span>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{contact.full_name}</span>
            {contact.title && <span style={{ color: '#6b7280', fontSize: 13 }}>— {contact.title}</span>}
            <span className="chip chip-muted" style={{ fontSize: 10 }}>
              score {contact.hunt_score.toFixed(2)}
            </span>
            <ContactStatusChip status={contact.contact_status} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6, fontSize: 12, color: '#6b7280' }}>
            {contact.email ? (
              <span>
                {contact.email_status === 'verified' && (
                  <Check size={11} style={{ display: 'inline', marginRight: 3, color: '#065f46', verticalAlign: '-1px' }} />
                )}
                {contact.email}{' '}
                <span style={{ color: '#9ca3af' }}>({contact.email_status || 'no status'})</span>
              </span>
            ) : (
              <span style={{ color: '#9ca3af' }}>no email returned</span>
            )}
            {contact.linkedin_url && (
              <a onClick={() => openExternal(contact.linkedin_url!)} style={{ cursor: 'pointer' }}>
                LinkedIn ↗
              </a>
            )}
          </div>
          {rankComponents && (
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
              why: archetype {(rankComponents.archetype_title ?? 0).toFixed(2)} · sen {(rankComponents.seniority ?? 0).toFixed(2)} · dept {(rankComponents.department ?? 0).toFixed(2)}
              {rankComponents.anti_pattern_penalty > 0 ? ` · anti-pattern -${rankComponents.anti_pattern_penalty.toFixed(2)}` : ''}
            </div>
          )}
        </div>
      </div>

      {/* Draft area */}
      <div style={{ marginTop: 14 }}>
        {!active && !isSkipped && (
          <button
            className="btn-primary"
            onClick={() => generateDraft(false)}
            disabled={drafting}
          >
            <Sparkles size={13} style={{ display: 'inline', marginRight: 6, verticalAlign: '-2px' }} />
            {drafting ? 'Drafting…' : 'Draft email'}
          </button>
        )}
        {active && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: '#6b7280' }}>
                Draft v{active.draft_version}{active.human_edited ? ' (edited)' : ''}
                {contact.draft_count > 1 && (
                  <>
                    {' · '}
                    <a
                      onClick={async () => {
                        if (!versions) await loadVersions();
                        else setVersions(null);
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      {versions ? 'hide versions' : `${contact.draft_count} versions`}
                    </a>
                  </>
                )}
              </span>
              {active.reasoning_trace && (
                <button
                  className="btn-ghost"
                  onClick={() => setShowWhy(!showWhy)}
                  style={{ fontSize: 12, padding: '2px 8px' }}
                  title="Show extended-thinking trace"
                >
                  <Brain size={11} style={{ display: 'inline', marginRight: 4, verticalAlign: '-1px' }} />
                  Why this angle
                </button>
              )}
            </div>

            {/* Version dropdown when expanded */}
            {versions && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10, padding: 8, background: '#f9fafb', borderRadius: 6 }}>
                {versions.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => switchVersion(v.id)}
                    style={{
                      background: v.is_active ? '#ede9fe' : 'transparent',
                      border: '1px solid ' + (v.is_active ? '#c4b5fd' : '#e5e7eb'),
                      borderRadius: 4,
                      padding: '6px 10px',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontSize: 12
                    }}
                  >
                    <b>v{v.draft_version}</b> {v.is_active && '(active)'} {v.human_edited && '· edited'}
                    {' — '}<span style={{ color: '#6b7280' }}>{v.subject}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Extended-thinking trace */}
            {showWhy && active.reasoning_trace && (
              <div
                style={{
                  background: '#f5f3ff',
                  border: '1px solid #e0e7ff',
                  borderRadius: 6,
                  padding: 10,
                  fontSize: 12,
                  color: '#3730a3',
                  marginBottom: 10,
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  maxHeight: 220,
                  overflowY: 'auto'
                }}
              >
                {active.one_line_why && <div style={{ fontWeight: 600, marginBottom: 8 }}>{active.one_line_why}</div>}
                {active.reasoning_trace}
              </div>
            )}

            {/* Draft body — edit-in-place when editing */}
            {editing ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input
                  className="input"
                  value={editSubject}
                  onChange={(e) => setEditSubject(e.target.value)}
                  placeholder="Subject"
                />
                <textarea
                  className="input"
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  style={{ minHeight: 140, fontFamily: 'inherit' }}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-primary" onClick={saveEdit}>Save edits</button>
                  <button className="btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div style={{
                background: '#ffffff',
                border: '1px solid #e5e7eb',
                borderRadius: 6,
                padding: 12,
                fontSize: 13,
                lineHeight: 1.55
              }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Subject: {active.subject}</div>
                <div style={{ whiteSpace: 'pre-wrap', color: '#1f2937' }}>{active.body}</div>
              </div>
            )}

            {/* Action row */}
            {!editing && !isSkipped && !isSent && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                <button className="btn-ghost" onClick={copyDraft} title="Copy subject + body to clipboard">
                  <Copy size={11} style={{ display: 'inline', marginRight: 4, verticalAlign: '-1px' }} />
                  Copy {copyHint && <span style={{ color: '#065f46' }}>✓</span>}
                </button>
                <button className="btn-ghost" onClick={startEdit}>
                  <Edit2 size={11} style={{ display: 'inline', marginRight: 4, verticalAlign: '-1px' }} />
                  Edit
                </button>
                <button className="btn-ghost" onClick={() => generateDraft(false)} disabled={drafting}>
                  <RefreshCw size={11} style={{ display: 'inline', marginRight: 4, verticalAlign: '-1px' }} />
                  {drafting ? 'Drafting…' : 'New version'}
                </button>
                <button className="btn-primary" onClick={markSent}>
                  <Send size={11} style={{ display: 'inline', marginRight: 4, verticalAlign: '-1px' }} />
                  Mark sent
                </button>
                <button className="btn-ghost" onClick={skip} title="Skip this contact (preserved across re-searches)">
                  <SkipForward size={11} style={{ display: 'inline', marginRight: 4, verticalAlign: '-1px' }} />
                  Skip
                </button>
              </div>
            )}
            {/* Regenerate-with-feedback row */}
            {!editing && !isSkipped && !isSent && (
              <details style={{ marginTop: 10 }}>
                <summary style={{ fontSize: 12, color: '#6b7280', cursor: 'pointer' }}>
                  Regenerate with feedback
                </summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                  <textarea
                    className="input"
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    placeholder="e.g. 'less corporate, more direct' or 'lead with the funding angle instead'"
                    style={{ minHeight: 60, fontFamily: 'inherit' }}
                  />
                  <button
                    className="btn-primary"
                    onClick={() => generateDraft(true)}
                    disabled={drafting || !feedback.trim()}
                    style={{ alignSelf: 'flex-start' }}
                  >
                    {drafting ? 'Regenerating…' : 'Regenerate'}
                  </button>
                </div>
              </details>
            )}
          </div>
        )}
        {isSkipped && (
          <button className="btn-ghost" onClick={unskip}>
            Restore
          </button>
        )}
        {isSent && (
          <div style={{ fontSize: 13, color: '#065f46' }}>
            ✓ Marked sent{contact.marked_sent_at ? ` on ${fmtDate(contact.marked_sent_at)}` : ''}
          </div>
        )}

        {draftError && (
          <div style={{ marginTop: 10, fontSize: 12, color: '#991b1b' }}>
            {draftError}
          </div>
        )}
      </div>
    </div>
  );
}

function ContactStatusChip({ status }: { status: string }) {
  if (status === 'pending')  return <span className="chip chip-muted" style={{ fontSize: 10 }}>pending</span>;
  if (status === 'drafted')  return <span className="chip chip-brand" style={{ fontSize: 10 }}>drafted</span>;
  if (status === 'sent')     return <span className="chip chip-qualified" style={{ fontSize: 10 }}>sent</span>;
  if (status === 'skipped')  return <span className="chip chip-muted" style={{ fontSize: 10 }}>skipped</span>;
  if (status === 'failed')   return <span className="chip chip-disqualified" style={{ fontSize: 10 }}>failed</span>;
  return <span className="chip chip-muted" style={{ fontSize: 10 }}>{status}</span>;
}

/**
 * v1.5.4: if the primary source link is dead, the scanner now also stores
 * up to 8 alternative citations from the Perplexity response. Surface them
 * here so the user has a fallback.
 */
function AlternativeSources({ rawSignal }: { rawSignal: string | null }) {
  if (!rawSignal) return null;
  let alts: string[] = [];
  let urlSource: string | undefined;
  try {
    const parsed = JSON.parse(rawSignal);
    alts = Array.isArray(parsed?.alt_sources) ? parsed.alt_sources : [];
    urlSource = typeof parsed?.url_source === 'string' ? parsed.url_source : undefined;
  } catch { /* not JSON or malformed — ignore */ }
  if (alts.length === 0 && !urlSource) return null;
  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed #e5e7eb' }}>
      {urlSource === 'citation' && (
        <div style={{ fontSize: 12, color: '#92400e', background: '#fef3c7', padding: '6px 10px', borderRadius: 6, marginBottom: 8 }}>
          The primary source URL was substituted from Perplexity's citations (the LLM's stated URL didn't match a real citation).
        </div>
      )}
      {urlSource === 'llm_unverified' && (
        <div style={{ fontSize: 12, color: '#92400e', background: '#fef3c7', padding: '6px 10px', borderRadius: 6, marginBottom: 8 }}>
          The source URL came directly from the LLM and wasn't verified against Perplexity's citations — if it's broken, no citations were available to substitute.
        </div>
      )}
      {alts.length > 0 && (
        <>
          <div className="label" style={{ marginBottom: 6 }}>Alternative sources</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {alts.map((url) => (
              <a
                key={url}
                onClick={() => openExternal(url)}
                style={{ fontSize: 13, cursor: 'pointer', wordBreak: 'break-all' }}
                title={url}
              >
                {url}
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
