import { useEffect, useState } from 'react';
import type { Settings as Sett } from '../../../shared/types';
import {
  scheduleToCron,
  cronToSchedule,
  describeSchedule,
  fmtHour,
  dayName,
  type Schedule,
  type FreqType
} from '../../../shared/schedule';

// v1.11.1: Spend card removed from Settings. Same data + more lives in the
// Cost Management tab. The STAGE_LABELS map and SpendStat component also
// moved with it; the canonical labels are now defined in CostManagement.tsx.
//
// v1.14.0: model pickers removed across both API cards (research / scan /
// brief / triage). The right model per task is now hardcoded in code; if we
// need to upgrade, we ship a new release rather than expecting the user to
// pick. Also: the cron text input was replaced with a frequency picker +
// contextual time selectors (see scheduleToCron / cronToSchedule helpers in
// src/shared/schedule.ts). And the v1.8 single-stage deep scan fallback
// toggle is gone — two-stage is now always-on.

const FREQ_OPTIONS: { value: FreqType; label: string }[] = [
  { value: 'daily',   label: 'Daily' },
  { value: 'twice',   label: 'Twice daily' },
  { value: 'every6',  label: 'Every 6 hours' },
  { value: 'every12', label: 'Every 12 hours' },
  { value: 'weekly',  label: 'Weekly' }
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({ value: h, label: fmtHour(h) }));
const DAY_OPTIONS = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ value: d, label: dayName(d) }));

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

  // v1.14.0: derive frequency-picker state from the persisted cron string.
  // Single source of truth is still settings.deepScanCron — the picker is a
  // structured editor on top of it. Round-tripping unknown crons folds
  // them back to the default (Twice daily 9am / 9pm).
  const schedule = cronToSchedule(s.deepScanCron);
  const setSchedule = (next: Schedule) => {
    setS({ ...s, deepScanCron: scheduleToCron(next) });
  };

  return (
    <div>
      <div style={{ marginTop: 16, marginBottom: 16 }}>
        <div className="h-page">Settings</div>
        <div style={{ color: '#6b7280', fontSize: 14, marginTop: 4 }}>
          API keys and tuning. (Spend details live on the <b>Cost Management</b> tab in the sidebar.)
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div className="h-card" style={{ marginBottom: 6 }}>Perplexity API</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          Used for product/brand research, source discovery, scheduled deep scans, and Live Monitor's qualification stage. All calls run live web search.
        </div>
        <label className="label">API key</label>
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
          How far back scans look for events. Slow-cycle signals (real estate, multi-year programmes, ESG commitments, M&A) telegraph over months. Fast-cycle signals (outages, CISO changes, breaches) need a tight window. This is the <b>global default</b>; per-brand and per-product overrides can be set in the brand/product editors.
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div className="h-card" style={{ marginBottom: 6 }}>Anthropic API</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          Used by the <i>Generate brief</i> button on each opportunity, Live Monitor's triage stage, and the deep scan's Claude qualification step. Models are fixed (Opus 4.7 for brief writing, Sonnet 4.6 for triage and qualify).
        </div>
        <label className="label">API key</label>
        <input
          className="input"
          type="password"
          value={s.anthropicApiKey}
          onChange={(e) => setS({ ...s, anthropicApiKey: e.target.value })}
          placeholder="sk-ant-…"
        />
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
        <div className="h-card" style={{ marginBottom: 6 }}>Research depth</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          When enabled, brand/product research chains Claude Opus after Perplexity to:
          (1) verify and sharpen the dossier — strip generic language, annotate per-field confidence, surface gaps as a "What we don't know" list;
          (2) produce a strategic-intelligence layer — ICP segments, buying-cycle scenarios, competitive plays.
          Adds ~$0.50–$0.80 per research run on top of the Perplexity cost. Needs an Anthropic API key (set above).
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
            <b>Stage 4 — fact-check</b>. After Stages 2+3 produce a verified dossier, Stage 4 fetches up to N cited source URLs from Stage 1 and asks Opus to verify the dossier's claims against actual source text. Adds ~$1.30–$1.80 per research run. Requires the toggle above to be on (Stage 4 needs Stage 2's verified dossier as input).
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
        <div className="h-card" style={{ marginBottom: 6 }}>Scheduled deep scan</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          The autonomous deep scan. For each researched product, Perplexity casts a wide net of real-world events and Claude qualifies which ones are genuine buying signals. Currently the most productive lead source in LeadsHawk. Runs on the schedule below.
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, marginBottom: 16 }}>
          <input
            type="checkbox"
            checked={s.deepScanEnabled}
            onChange={(e) => setS({ ...s, deepScanEnabled: e.target.checked })}
          /> Enable scheduled scans
        </label>

        <label className="label">Frequency</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6, marginBottom: 12 }}>
          {FREQ_OPTIONS.map((opt) => {
            const active = schedule.freq === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => {
                  // Preserve sensible hours/dow when switching frequency.
                  const carryHour = schedule.hours[0] ?? 9;
                  const carrySecond = schedule.hours[1] ?? 21;
                  if (opt.value === 'daily')   setSchedule({ freq: 'daily',   hours: [carryHour], dayOfWeek: schedule.dayOfWeek });
                  if (opt.value === 'twice')   setSchedule({ freq: 'twice',   hours: [carryHour, carrySecond], dayOfWeek: schedule.dayOfWeek });
                  if (opt.value === 'every6')  setSchedule({ freq: 'every6',  hours: [], dayOfWeek: schedule.dayOfWeek });
                  if (opt.value === 'every12') setSchedule({ freq: 'every12', hours: [], dayOfWeek: schedule.dayOfWeek });
                  if (opt.value === 'weekly')  setSchedule({ freq: 'weekly',  hours: [carryHour], dayOfWeek: schedule.dayOfWeek });
                }}
                style={{
                  padding: '8px 14px',
                  borderRadius: 999,
                  border: active ? '1px solid #6c5cf2' : '1px solid #e5e7eb',
                  background: active ? '#6c5cf2' : 'white',
                  color: active ? 'white' : '#111827',
                  fontSize: 13,
                  fontWeight: active ? 600 : 500,
                  cursor: 'pointer',
                  transition: 'all 0.12s'
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        {schedule.freq === 'daily' && (
          <div style={{ marginBottom: 12 }}>
            <label className="label">At</label>
            <select
              className="select"
              value={schedule.hours[0] ?? 9}
              onChange={(e) => setSchedule({ ...schedule, hours: [Number(e.target.value)] })}
              style={{ maxWidth: 200 }}
            >
              {HOUR_OPTIONS.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
            </select>
          </div>
        )}

        {schedule.freq === 'twice' && (
          <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
            <div>
              <label className="label">First run</label>
              <select
                className="select"
                value={schedule.hours[0] ?? 9}
                onChange={(e) => setSchedule({ ...schedule, hours: [Number(e.target.value), schedule.hours[1] ?? 21] })}
                style={{ maxWidth: 200 }}
              >
                {HOUR_OPTIONS.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Second run</label>
              <select
                className="select"
                value={schedule.hours[1] ?? 21}
                onChange={(e) => setSchedule({ ...schedule, hours: [schedule.hours[0] ?? 9, Number(e.target.value)] })}
                style={{ maxWidth: 200 }}
              >
                {HOUR_OPTIONS.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
              </select>
            </div>
          </div>
        )}

        {schedule.freq === 'weekly' && (
          <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
            <div>
              <label className="label">On</label>
              <select
                className="select"
                value={schedule.dayOfWeek}
                onChange={(e) => setSchedule({ ...schedule, dayOfWeek: Number(e.target.value) })}
                style={{ maxWidth: 200 }}
              >
                {DAY_OPTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label">At</label>
              <select
                className="select"
                value={schedule.hours[0] ?? 9}
                onChange={(e) => setSchedule({ ...schedule, hours: [Number(e.target.value)] })}
                style={{ maxWidth: 200 }}
              >
                {HOUR_OPTIONS.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
              </select>
            </div>
          </div>
        )}

        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 16, fontStyle: 'italic' }}>
          {describeSchedule(schedule)}
        </div>

        <label className="label">Deep scan model (Stage 1 discovery)</label>
        <select
          className="select"
          value={s.deepScanModel}
          onChange={(e) => setS({ ...s, deepScanModel: e.target.value })}
        >
          <option value="sonar-deep-research">sonar-deep-research (recommended — multi-step research)</option>
          <option value="sonar-reasoning-pro">sonar-reasoning-pro (chain-of-thought, mid-tier)</option>
          <option value="sonar-pro">sonar-pro (cheapest — narrower discovery)</option>
        </select>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
          Controls the Perplexity model used for Stage 1 discovery. Stage 2 qualification always uses Claude Sonnet 4.6.
        </div>
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
