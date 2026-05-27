import { useEffect, useState } from 'react';
import type { Settings as Sett } from '../../../shared/types';

// v1.11.1: Spend card removed from Settings. Same data + more lives in the
// Cost Management tab. The STAGE_LABELS map and SpendStat component also
// moved with it; the canonical labels are now defined in CostManagement.tsx.

export function Settings() {
  const [s, setS] = useState<Sett | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { window.lh.settings.get().then(setS); }, []);

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
          API keys, models, and scanner tuning. (Spend details moved to the <b>Cost Management</b> tab in the sidebar.)
        </div>
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
          Items must score above this against at least one product signal to advance past the free local pre-filter. Lower = wider net, higher Sonnet triage cost. <b>Recommended: 0.40.</b> If your funnel shows "Ingested {'>'}  0, Candidates 0", this is the most likely cause — most real product-signal vs news-headline matches sit between 0.40 and 0.50.
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
        <div className="h-card" style={{ marginBottom: 6 }}>Research depth (v1.10)</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          When enabled, brand/product research chains Claude Opus after Perplexity to:
          (1) verify and sharpen the dossier — strip generic language, annotate per-field confidence, surface gaps as a "What we don't know" list;
          (2) produce a strategic-intelligence layer — ICP segments, buying-cycle scenarios, competitive plays.
          Adds ~$0.50–$0.80 per research run on top of the Perplexity cost. Needs an Anthropic API key (set above).
          Uncheck to revert to v1.9.x's Perplexity-only research.
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={s.brandResearchAdvanced}
            onChange={(e) => setS({ ...s, brandResearchAdvanced: e.target.checked })}
          /> Opus verification + strategic intel on <b style={{ margin: '0 4px' }}>brand</b> research
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
          <input
            type="checkbox"
            checked={s.productResearchAdvanced}
            onChange={(e) => setS({ ...s, productResearchAdvanced: e.target.checked })}
          /> Opus verification + strategic intel on <b style={{ margin: '0 4px' }}>product</b> research
        </label>

        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px dashed #e5e7eb' }}>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
            <b>Stage 4 — fact-check (v1.10.2)</b>. After Stages 2+3 produce a verified dossier, Stage 4 fetches up to N cited source URLs from Stage 1 and asks Opus to verify the dossier's claims against actual source text. Adds ~$1.30–$1.80 per research run. Requires the toggle above to be on (Stage 4 needs Stage 2's verified dossier as input).
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={s.brandResearchFactCheck}
              onChange={(e) => setS({ ...s, brandResearchFactCheck: e.target.checked })}
            /> Opus fact-check on <b style={{ margin: '0 4px' }}>brand</b> research
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={s.productResearchFactCheck}
              onChange={(e) => setS({ ...s, productResearchFactCheck: e.target.checked })}
            /> Opus fact-check on <b style={{ margin: '0 4px' }}>product</b> research
          </label>
          <label className="label">Max sources fetched per fact-check call</label>
          <input
            className="input"
            type="number"
            min="1"
            max="15"
            value={s.factCheckMaxSources}
            onChange={(e) => setS({ ...s, factCheckMaxSources: Math.max(1, Math.min(15, Number(e.target.value) || 10)) })}
            style={{ maxWidth: 120 }}
          />
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
            Lower = cheaper + faster fact-check. Higher = more sources verified. Range 1–15. Default 10. Each source is fetched in parallel; unreachable URLs are skipped gracefully.
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div className="h-card" style={{ marginBottom: 6 }}>Scan</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          The autonomous scan engine — two-stage by default: Perplexity sonar-deep-research discovery + Claude qualification. Slower and costlier per run than the retired v1.x manual scan, but produces meaningfully better leads. Set the schedule below; the on/off toggle is the checkbox.
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={s.deepScanEnabled}
            onChange={(e) => setS({ ...s, deepScanEnabled: e.target.checked })}
          /> Enable scheduled scans
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
