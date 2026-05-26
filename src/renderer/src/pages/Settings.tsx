import { useEffect, useState } from 'react';
import type { Settings as Sett, SpendSummary } from '../../../shared/types';

const STAGE_LABELS: Record<string, string> = {
  research: 'Product research',
  brand_research: 'Brand research',
  brand_summary: 'Brand summary',
  refresh_signals: 'Refresh signals',
  manual_scan: 'Manual scan',
  deep_scan: 'Deep scan (single-stage)',
  deep_scan_discovery: 'Deep scan — Stage 1 discovery',
  deep_scan_qualify: 'Deep scan — Stage 2 qualify',
  triage: 'Live Monitor — triage',
  qualify: 'Live Monitor — qualify',
  brief: 'Sales brief',
  unknown: 'Other / untagged'
};

export function Settings() {
  const [s, setS] = useState<Sett | null>(null);
  const [saved, setSaved] = useState(false);
  const [spend, setSpend] = useState<SpendSummary | null>(null);

  useEffect(() => { window.lh.settings.get().then(setS); }, []);
  useEffect(() => {
    const load = () => window.lh.spend.summary().then(setSpend).catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  if (!s) return <div style={{ padding: 24 }}>Loading…</div>;

  const save = async () => {
    const next = await window.lh.settings.update(s);
    setS(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div>
      <div style={{ marginTop: 16, marginBottom: 16 }}>
        <div className="h-page">Settings</div>
        <div style={{ color: '#6b7280', fontSize: 14, marginTop: 4 }}>
          API keys, models, and scanner tuning
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div className="h-card" style={{ marginBottom: 6 }}>Spend</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>
          Estimated LLM cost (Perplexity + Anthropic). Rates are best-effort; consult provider invoices for the source of truth.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 18 }}>
          <SpendStat label="Today"     value={spend?.today  ?? 0} />
          <SpendStat label="Last 7 d"  value={spend?.last7d ?? 0} />
          <SpendStat label="Last 30 d" value={spend?.last30d ?? 0} />
        </div>
        {spend && spend.byStage.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table className="lh" style={{ minWidth: 480 }}>
              <thead>
                <tr>
                  <th>Stage (last 30 d)</th>
                  <th style={{ textAlign: 'right' }}>Calls</th>
                  <th style={{ textAlign: 'right' }}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {spend.byStage.map((row) => (
                  <tr key={row.stage}>
                    <td>{STAGE_LABELS[row.stage] || row.stage}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{row.calls}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>${row.cost.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(!spend || spend.byStage.length === 0) && (
          <div style={{ fontSize: 13, color: '#9ca3af' }}>No API calls logged yet — run a scan or research a product.</div>
        )}
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div className="h-card" style={{ marginBottom: 6 }}>Perplexity API</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          Used for product research (<i>Run research</i>) and the autonomous scan job. Both use live web search.
        </div>
        <label className="label">API Key</label>
        <input
          className="input"
          type="password"
          value={s.perplexityApiKey}
          onChange={(e) => setS({ ...s, perplexityApiKey: e.target.value })}
          placeholder="pplx-…"
        />
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
          Get one at perplexity.ai/settings/api.
        </div>

        <div style={{ height: 16 }} />
        <label className="label">Research model (used by “Run research”)</label>
        <select
          className="select"
          value={s.perplexityResearchModel}
          onChange={(e) => setS({ ...s, perplexityResearchModel: e.target.value })}
        >
          <option value="sonar-deep-research">sonar-deep-research (multi-step deep research — recommended)</option>
          <option value="sonar-reasoning-pro">sonar-reasoning-pro (chain-of-thought, faster)</option>
          <option value="sonar-pro">sonar-pro (fastest)</option>
        </select>

        <div style={{ height: 16 }} />
        <label className="label">Scan model (used by autonomous scans)</label>
        <select
          className="select"
          value={s.perplexityScanModel}
          onChange={(e) => setS({ ...s, perplexityScanModel: e.target.value })}
        >
          <option value="sonar-pro">sonar-pro (recommended — fast live search)</option>
          <option value="sonar-reasoning-pro">sonar-reasoning-pro (more deliberate)</option>
          <option value="sonar">sonar (cheapest)</option>
        </select>

        <div style={{ height: 16 }} />
        <label className="label">Recency window for scans</label>
        <select
          className="select"
          value={s.scanRecency}
          onChange={(e) => setS({ ...s, scanRecency: e.target.value as 'day' | 'week' | 'month' | 'year' })}
        >
          <option value="day">Last 24 hours</option>
          <option value="week">Last 7 days</option>
          <option value="month">Last 30 days</option>
          <option value="year">Last 12 months</option>
        </select>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
          Slow-cycle signals (real estate, multi-year programmes, ESG commitments, M&A) telegraph over months. Fast-cycle signals (outages, CISO changes, breaches) need a tight window. This is the global default — per-brand and per-product overrides land in v1.8.
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div className="h-card" style={{ marginBottom: 6 }}>Anthropic API</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          Used by the <i>Generate brief</i> button and by the Live Monitor's triage stage.
        </div>
        <label className="label">API Key</label>
        <input
          className="input"
          type="password"
          value={s.anthropicApiKey}
          onChange={(e) => setS({ ...s, anthropicApiKey: e.target.value })}
          placeholder="sk-ant-…"
        />
        <div style={{ height: 12 }} />
        <label className="label">Brief-generation model</label>
        <select className="select" value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })}>
          <option value="claude-opus-4-7">claude-opus-4-7 (most capable)</option>
          <option value="claude-sonnet-4-6">claude-sonnet-4-6 (balanced)</option>
          <option value="claude-haiku-4-5-20251001">claude-haiku-4-5 (fastest)</option>
        </select>
        <div style={{ height: 12 }} />
        <label className="label">Live-monitor triage model</label>
        <select className="select" value={s.triageModel} onChange={(e) => setS({ ...s, triageModel: e.target.value })}>
          <option value="claude-sonnet-4-6">claude-sonnet-4-6 (recommended)</option>
          <option value="claude-opus-4-7">claude-opus-4-7 (more deliberate, costlier)</option>
          <option value="claude-haiku-4-5-20251001">claude-haiku-4-5 (cheapest, slightly noisier)</option>
        </select>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
          Used for the cheap yes/no triage on each candidate item before deep qualification.
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div className="h-card" style={{ marginBottom: 6 }}>Live Monitor</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          24/7 monitoring runs an ingestion → embedding filter → Claude triage → Perplexity qualify funnel. The on/off toggle lives on the Live Monitor page; tuning lives here.
        </div>
        <label className="label">Embedding similarity threshold</label>
        <input
          className="input"
          type="number" step="0.05" min="0" max="1"
          value={s.embedSimilarityThreshold}
          onChange={(e) => setS({ ...s, embedSimilarityThreshold: Number(e.target.value) })}
        />
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
          Items must score above this against at least one product signal to advance past the free local pre-filter. Lower = wider net, higher LLM cost.
        </div>
        <div style={{ height: 16 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
          <input
            type="checkbox"
            checked={s.notifyOnNewOpportunity}
            onChange={(e) => setS({ ...s, notifyOnNewOpportunity: e.target.checked })}
          /> macOS notifications on new opportunities
        </label>
        <div style={{ height: 12 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
          <input
            type="checkbox"
            checked={s.openAtLogin}
            onChange={(e) => setS({ ...s, openAtLogin: e.target.checked })}
          /> Start LeadsHawk automatically when you log in (recommended for 24/7 monitoring)
        </label>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div className="h-card" style={{ marginBottom: 6 }}>Deep Research Scan</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          A third, heavier scanning engine — uses Perplexity's deep-research model on its own cron, separate from the regular hourly/6-hourly scan. Costlier per call, but reasons harder and pulls from more sources. The schedule lives here; the on/off toggle is the checkbox below.
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={s.deepScanEnabled}
            onChange={(e) => setS({ ...s, deepScanEnabled: e.target.checked })}
          /> Enable deep research scans on schedule
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, marginBottom: 6 }}>
          <input
            type="checkbox"
            checked={s.deepScanTwoStage}
            onChange={(e) => setS({ ...s, deepScanTwoStage: e.target.checked })}
          /> Use two-stage deep scan (recommended)
        </label>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          Splits the call into Perplexity-led discovery (wide net of named
          companies + citations) and Claude-led qualification (ICP fit, scan
          rules, dedupe, confidence). Better leads at roughly the same cost.
          Uncheck to fall back to the v1.8 monolithic single-call path.
        </div>
        <label className="label">Cron expression</label>
        <input
          className="input"
          value={s.deepScanCron}
          onChange={(e) => setS({ ...s, deepScanCron: e.target.value })}
        />
        <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[
            { label: 'Twice daily (9am / 9pm)', value: '0 9,21 * * *' },
            { label: 'Daily at 9am',            value: '0 9 * * *' },
            { label: 'Every 12 hours',          value: '0 */12 * * *' },
            { label: 'Weekly Mon 9am',          value: '0 9 * * 1' }
          ].map((p) => (
            <button key={p.value} className="btn-ghost" onClick={() => setS({ ...s, deepScanCron: p.value })}>{p.label}</button>
          ))}
        </div>
        <div style={{ height: 16 }} />
        <label className="label">Deep scan model</label>
        <select
          className="select"
          value={s.deepScanModel}
          onChange={(e) => setS({ ...s, deepScanModel: e.target.value })}
        >
          <option value="sonar-deep-research">sonar-deep-research (recommended — multi-step research, costliest)</option>
          <option value="sonar-reasoning-pro">sonar-reasoning-pro (chain-of-thought, mid-tier)</option>
          <option value="sonar-pro">sonar-pro (same as regular scan — useful if you just want more frequent runs)</option>
        </select>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div className="h-card" style={{ marginBottom: 12 }}>Scanner tuning</div>
        <label className="label">Minimum confidence to flag as opportunity</label>
        <input
          className="input"
          type="number" step="0.05" min="0" max="1"
          value={s.minConfidence}
          onChange={(e) => setS({ ...s, minConfidence: Number(e.target.value) })}
        />
        <div style={{ height: 12 }} />
        <label className="label">Max opportunities per scan source</label>
        <input
          className="input"
          type="number" min="1" max="50"
          value={s.maxItemsPerScan}
          onChange={(e) => setS({ ...s, maxItemsPerScan: Number(e.target.value) })}
        />
      </div>

      <button className="btn-primary" onClick={save}>Save settings</button>
      {saved && <span style={{ marginLeft: 12, color: '#065f46', fontSize: 13 }}>Saved.</span>}
    </div>
  );
}

function SpendStat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
      <div className="label" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#111827', fontVariantNumeric: 'tabular-nums' }}>
        ${value.toFixed(2)}
      </div>
    </div>
  );
}
