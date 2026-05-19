import { useEffect, useState } from 'react';
import type { Settings as Sett } from '../../../shared/types';

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
          API keys, models, and scanner tuning
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
          onChange={(e) => setS({ ...s, scanRecency: e.target.value as 'day' | 'week' | 'month' })}
        >
          <option value="day">Last 24 hours</option>
          <option value="week">Last 7 days</option>
          <option value="month">Last 30 days</option>
        </select>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div className="h-card" style={{ marginBottom: 6 }}>Anthropic API</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          Used only by the <i>Generate brief</i> button on the Opportunity Detail page.
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
        <label className="label">Model</label>
        <select className="select" value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })}>
          <option value="claude-opus-4-7">claude-opus-4-7 (most capable)</option>
          <option value="claude-sonnet-4-6">claude-sonnet-4-6 (balanced)</option>
          <option value="claude-haiku-4-5-20251001">claude-haiku-4-5 (fastest)</option>
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
