/**
 * v1.11.0 — Cost Management tab.
 *
 * Aggregates api_calls rows into user-facing operation buckets so spend
 * is readable in terms of "Brand research" / "Deep scan" / etc., not
 * raw LlmStage values. Existing Settings → Spend card stays as a glance
 * summary; this page is the detailed view.
 */

import { useEffect, useState } from 'react';
import type { CostSummary, OperationBucket, ScanRunCostRow } from '../../../shared/types';
import { fmtDateShort } from '../lib/api';

const STAGE_LABELS: Record<string, string> = {
  research: 'Product research — Stage 1 (Perplexity)',
  brand_research: 'Brand research — Stage 1 (Perplexity)',
  brand_research_verify: 'Brand research — Stage 2 (Opus verify)',
  brand_research_strategic: 'Brand research — Stage 3 (Opus strategic)',
  brand_research_factcheck: 'Brand research — Stage 4 (Opus fact-check)',
  product_research_verify: 'Product research — Stage 2 (Opus verify)',
  product_research_strategic: 'Product research — Stage 3 (Opus strategic)',
  product_research_factcheck: 'Product research — Stage 4 (Opus fact-check)',
  brand_summary: 'Brand summary (legacy)',
  refresh_signals: 'Refresh signals (legacy)',
  brand_signals: 'Signal research — brand',
  product_signals: 'Signal research — product',
  brand_source_research: 'Source research — brand',
  manual_scan: 'Manual scan',
  deep_scan: 'Deep scan (single-stage, legacy)',
  deep_scan_discovery: 'Deep scan — Stage 1 discovery',
  deep_scan_qualify: 'Deep scan — Stage 2 qualify',
  triage: 'Live Monitor — triage',
  qualify: 'Live Monitor — qualify',
  brief: 'Sales brief',
  // v1.19.0 — contact outreach stages.
  contact_archetype: 'Contact outreach — archetype (Sonnet)',
  contact_draft: 'Contact outreach — draft (Opus + extended thinking)',
  contact_lookup: 'Contact outreach — Apollo lookup',
  unknown: 'Other / untagged'
};

function fmt(n: number): string {
  return `$${n.toFixed(4)}`;
}
function fmtShort(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function CostManagement() {
  const [data, setData] = useState<CostSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const s = await window.lh.cost.summary();
      setData(s);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div>
      <div style={{ marginTop: 16, marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <div className="h-page">Cost Management</div>
          <div style={{ color: '#6b7280', fontSize: 14, marginTop: 4 }}>
            API spend broken down by operation, model, stage, and provider.
            Auto-refreshes every 30 seconds.
          </div>
        </div>
        <button className="btn-ghost" onClick={refresh} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh now'}
        </button>
      </div>

      {!data && (
        <div style={{ padding: 24, color: '#6b7280' }}>
          {loading ? 'Loading…' : 'No data available.'}
        </div>
      )}

      {data && (
        <>
          {/* ── Period totals card ──────────────────────────────── */}
          <div className="card" style={{ padding: 20, marginBottom: 16 }}>
            <div className="h-card" style={{ marginBottom: 6 }}>Period totals</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>
              Estimated LLM cost across all operations. Rates are best-effort
              — consult provider invoices for the source of truth.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
              <PeriodStat label="Today"        value={data.today.totalCost} />
              <PeriodStat label="Last 7 days"  value={data.last7d.totalCost} />
              <PeriodStat label="Last 30 days" value={data.last30d.totalCost} />
              <PeriodStat label="All time"     value={data.allTime.totalCost} />
            </div>
          </div>

          {/* ── By operation type ──────────────────────────────── */}
          <div className="card" style={{ padding: 20, marginBottom: 16 }}>
            <div className="h-card" style={{ marginBottom: 6 }}>Cost by operation type</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>
              Aggregated by what you actually do in the app (not by individual stage).
              "Brand research" sums all 4 stages of a brand-research run; same for product research.
            </div>
            <OperationTable
              today={data.today.byOperation}
              last7d={data.last7d.byOperation}
              last30d={data.last30d.byOperation}
              allTime={data.allTime.byOperation}
            />
          </div>

          {/* ── Recent scan runs (per-instance cost) ─────────── */}
          <div className="card" style={{ padding: 20, marginBottom: 16 }}>
            <div className="h-card" style={{ marginBottom: 6 }}>Recent scan runs — cost per instance</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>
              Each row is one manual or deep-scan invocation from the last 30 days.
              Cost is the sum of all scan-related API calls (Perplexity + Opus Stage 2) that fired during the run's start-to-finish window.
              Live Monitor and research costs are excluded from this column.
            </div>
            <ScanRunsTable runs={data.recentScanRuns} />
          </div>

          {/* ── By provider (last 30d) ────────────────────────── */}
          <div className="card" style={{ padding: 20, marginBottom: 16 }}>
            <div className="h-card" style={{ marginBottom: 6 }}>By provider (last 30 days)</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>
              Useful for matching against each provider's monthly billing dashboard.
            </div>
            {data.byProvider30d.length === 0 ? (
              <div style={{ color: '#9ca3af', fontSize: 13 }}>No API calls in the last 30 days.</div>
            ) : (
              <table className="lh">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th style={{ textAlign: 'right' }}>Calls</th>
                    <th style={{ textAlign: 'right' }}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byProvider30d.map((p) => (
                    <tr key={p.provider}>
                      <td style={{ textTransform: 'capitalize' }}>{p.provider}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{p.calls}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(p.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* ── By model (last 30d) ───────────────────────────── */}
          <div className="card" style={{ padding: 20, marginBottom: 16 }}>
            <div className="h-card" style={{ marginBottom: 14 }}>By model (last 30 days)</div>
            {data.byModel30d.length === 0 ? (
              <div style={{ color: '#9ca3af', fontSize: 13 }}>No API calls in the last 30 days.</div>
            ) : (
              <table className="lh">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th style={{ textAlign: 'right' }}>Calls</th>
                    <th style={{ textAlign: 'right' }}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byModel30d.map((m) => (
                    <tr key={m.model}>
                      <td style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 13 }}>{m.model}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{m.calls}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(m.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* ── By stage (last 30d) — detailed drill-down ─────── */}
          <div className="card" style={{ padding: 20 }}>
            <div className="h-card" style={{ marginBottom: 6 }}>By stage (last 30 days)</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>
              Finest-grained view — each pipeline stage tracked individually. Same data shown in Settings → Spend.
            </div>
            {data.byStage30d.length === 0 ? (
              <div style={{ color: '#9ca3af', fontSize: 13 }}>No API calls in the last 30 days.</div>
            ) : (
              <table className="lh">
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th style={{ textAlign: 'right' }}>Calls</th>
                    <th style={{ textAlign: 'right' }}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byStage30d.map((s) => (
                    <tr key={s.stage}>
                      <td>{STAGE_LABELS[s.stage] || s.stage}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{s.calls}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(s.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ScanRunsTable({ runs }: { runs: ScanRunCostRow[] }) {
  if (!runs || runs.length === 0) {
    return <div style={{ color: '#9ca3af', fontSize: 13 }}>No scan runs in the last 30 days.</div>;
  }
  const totalCost = runs.reduce((s, r) => s + r.cost, 0);
  const totalOpps = runs.reduce((s, r) => s + (r.opportunities_created || 0), 0);
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="lh">
        <thead>
          <tr>
            <th>Started</th>
            <th>Kind</th>
            <th>Status</th>
            <th style={{ textAlign: 'right' }}>Items scanned</th>
            <th style={{ textAlign: 'right' }}>Opps</th>
            <th style={{ textAlign: 'right' }}>API calls</th>
            <th style={{ textAlign: 'right' }}>Cost</th>
            <th style={{ textAlign: 'right' }}>Cost / opp</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const costPerOpp = r.opportunities_created > 0 ? r.cost / r.opportunities_created : null;
            const statusChip =
              r.status === 'completed' ? 'chip-qualified' :
              r.status === 'running'   ? 'chip-open' :
              r.status === 'error'     ? 'chip-disqualified' : 'chip-muted';
            const kindChip = r.kind === 'deep' ? 'chip-brand' : 'chip-muted';
            return (
              <tr key={r.run_id}>
                <td style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmtDateShort(r.started_at)}</td>
                <td><span className={`chip ${kindChip}`}>{r.kind === 'deep' ? 'deep research' : 'manual'}</span></td>
                <td><span className={`chip ${statusChip}`}>{r.status}</span></td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.items_scanned}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.opportunities_created}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.api_calls}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{fmt(r.cost)}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#6b7280' }}>
                  {costPerOpp === null ? '—' : fmt(costPerOpp)}
                </td>
              </tr>
            );
          })}
          <tr style={{ borderTop: '2px solid #e5e7eb', fontWeight: 600 }}>
            <td>Total ({runs.length} runs)</td>
            <td></td>
            <td></td>
            <td></td>
            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{totalOpps}</td>
            <td></td>
            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(totalCost)}</td>
            <td></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function PeriodStat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
      <div className="label" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#111827', fontVariantNumeric: 'tabular-nums' }}>
        {fmtShort(value)}
      </div>
    </div>
  );
}

function OperationTable({
  today, last7d, last30d, allTime
}: {
  today: OperationBucket[];
  last7d: OperationBucket[];
  last30d: OperationBucket[];
  allTime: OperationBucket[];
}) {
  // Merge into a single map keyed by operation so we can show all four windows
  // side-by-side. Always show all 8 operation rows even if zero (so users see
  // the full landscape).
  type Row = { operation: string; label: string; today: number; last7d: number; last30d: number; allTime: number; calls30d: number };
  const map = new Map<string, Row>();
  const add = (bucket: OperationBucket[], field: 'today' | 'last7d' | 'last30d' | 'allTime') => {
    for (const b of bucket) {
      const existing = map.get(b.operation) ?? {
        operation: b.operation, label: b.label,
        today: 0, last7d: 0, last30d: 0, allTime: 0, calls30d: 0
      };
      existing[field] = b.cost;
      if (field === 'last30d') existing.calls30d = b.calls;
      map.set(b.operation, existing);
    }
  };
  add(today, 'today');
  add(last7d, 'last7d');
  add(last30d, 'last30d');
  add(allTime, 'allTime');

  const rows = [...map.values()].sort((a, b) => b.last30d - a.last30d);
  if (rows.length === 0) {
    return <div style={{ color: '#9ca3af', fontSize: 13 }}>No API calls logged yet.</div>;
  }

  const tot = (k: 'today' | 'last7d' | 'last30d' | 'allTime') =>
    rows.reduce((s, r) => s + r[k], 0);

  return (
    <table className="lh">
      <thead>
        <tr>
          <th>Operation</th>
          <th style={{ textAlign: 'right' }}>Calls (30d)</th>
          <th style={{ textAlign: 'right' }}>Today</th>
          <th style={{ textAlign: 'right' }}>Last 7d</th>
          <th style={{ textAlign: 'right' }}>Last 30d</th>
          <th style={{ textAlign: 'right' }}>All time</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.operation}>
            <td>{r.label}</td>
            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.calls30d}</td>
            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(r.today)}</td>
            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(r.last7d)}</td>
            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmt(r.last30d)}</td>
            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(r.allTime)}</td>
          </tr>
        ))}
        <tr style={{ borderTop: '2px solid #e5e7eb', fontWeight: 600 }}>
          <td>Total</td>
          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}></td>
          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(tot('today'))}</td>
          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(tot('last7d'))}</td>
          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(tot('last30d'))}</td>
          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(tot('allTime'))}</td>
        </tr>
      </tbody>
    </table>
  );
}
