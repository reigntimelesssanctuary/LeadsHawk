import { useEffect, useState } from 'react';
import { Switch } from '../components/Switch';
import { Modal } from '../components/Modal';
import type { MonitorStatus, MonitorSource, SignalItem, SourceHealth } from '../../../shared/types';
import { fmtDate, fmtDateSGT, openExternal } from '../lib/api';
import { Activity, Plus, Trash2, RefreshCw, AlertCircle, Radio } from 'lucide-react';

export function LiveMonitor({ onOpenOpp }: { onOpenOpp: (id: number) => void }) {
  const [status, setStatus] = useState<MonitorStatus | null>(null);
  const [items, setItems] = useState<SignalItem[]>([]);
  const [sources, setSources] = useState<MonitorSource[]>([]);
  const [health, setHealth] = useState<SourceHealth[]>([]);
  const [spendToday, setSpendToday] = useState<number | null>(null);
  const [showAddSource, setShowAddSource] = useState(false);

  const refresh = async () => {
    setStatus(await window.lh.monitor.status());
    setItems(await window.lh.monitor.items(80));
    setSources(await window.lh.monitor.sources());
    setHealth(await window.lh.monitor.sourcesHealth());
    try {
      const s = await window.lh.spend.summary();
      setSpendToday(s.today);
    } catch { /* spend is best-effort */ }
  };
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  const toggle = async (on: boolean) => {
    await window.lh.settings.update({ liveMonitoringEnabled: on });
    if (on) await window.lh.monitor.start();
    else await window.lh.monitor.stop();
    refresh();
  };

  return (
    <div>
      <div style={{ marginTop: 16, marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <div className="h-page">Live Monitor</div>
          <div style={{ color: '#6b7280', fontSize: 14, marginTop: 4 }}>
            24/7 funnel — RSS ingestion → local embedding pre-filter → Claude triage → Perplexity deep qualify
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {spendToday !== null && (
            <span
              title="Total LLM spend (Perplexity + Anthropic) today across all stages."
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#4b5563', background: '#f3f4f6', padding: '4px 10px', borderRadius: 999 }}
            >
              ${spendToday.toFixed(2)} today
            </span>
          )}
          {status?.running && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#065f46', fontSize: 13 }}>
              <Radio size={14} className="lh-pulse" /> live
            </span>
          )}
          <Switch
            checked={!!status?.running}
            label="Live monitoring"
            onChange={toggle}
          />
        </div>
      </div>

      {status && status.embedderState !== 'ready' && status.running && (
        <div className="card" style={{ padding: 16, marginBottom: 16, background: '#fff7ed', borderColor: '#fed7aa', display: 'flex', alignItems: 'center', gap: 12 }}>
          <AlertCircle size={20} style={{ color: '#c2410c' }} />
          <div style={{ fontSize: 14, color: '#7c2d12' }}>
            {status.embedderState === 'loading'
              ? 'Loading the on-device embedding model (~22 MB, one-time download)…'
              : status.embedderState === 'error'
                ? `Embedding model failed to load: ${status.embedderError}`
                : 'Embedding model not ready yet.'}
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 20 }}>
        <FunnelCard label="Ingested" value={status?.last24h.ingested ?? 0} sublabel="last 24 h" color="#1f2937" />
        <FunnelCard label="Candidates" value={status?.last24h.candidates ?? 0} sublabel="passed embedding filter" color="#6c5cf2" />
        <FunnelCard label="Triaged strong" value={status?.last24h.triagedStrong ?? 0} sublabel="passed Sonnet triage" color="#0891b2" />
        <FunnelCard label="Opportunities" value={status?.last24h.qualified ?? 0} sublabel="deep-qualified" color="#065f46" />
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 20 }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="h-section">Recent items</div>
          <button className="btn-ghost" onClick={refresh}>
            <RefreshCw size={13} style={{ display: 'inline', marginRight: 4 }} /> Refresh
          </button>
        </div>
        <table className="lh">
          <thead>
            <tr>
              <th>Fetched</th>
              <th>Title</th>
              <th>Stage</th>
              <th>Score</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: 'center', color: '#6b7280', padding: 28 }}>
                {status?.running ? 'No items yet. Wait for the first poll cycle.' : 'Live monitoring is off.'}
              </td></tr>
            )}
            {items.map((it) => (
              <tr key={it.id}>
                <td style={{ whiteSpace: 'nowrap', fontSize: 13, color: '#6b7280' }} title="Singapore time (UTC+8)">
                  {fmtDateSGT(it.fetched_at)}
                </td>
                <td style={{ maxWidth: 420 }}>
                  <div style={{ fontWeight: 500 }}>{it.title}</div>
                  {it.snippet && (
                    <div style={{ color: '#6b7280', fontSize: 12, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical' }}>{it.snippet}</div>
                  )}
                </td>
                <td><StageChip status={it.status} /></td>
                <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: '#4b5563' }}>
                  {it.best_match_similarity !== null && it.best_match_similarity !== undefined && (
                    <div>sim&nbsp;{it.best_match_similarity.toFixed(2)}</div>
                  )}
                  {it.triage_confidence !== null && it.triage_confidence !== undefined && (
                    <div>triage&nbsp;{it.triage_confidence.toFixed(2)}</div>
                  )}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {it.opportunity_id ? (
                    <button className="btn-ghost" onClick={() => onOpenOpp(it.opportunity_id!)}>Open</button>
                  ) : (
                    <button className="btn-ghost" onClick={() => openExternal(it.url)}>Source</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ padding: 20, overflowX: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <div className="h-section">Sources</div>
          <button className="btn-ghost" onClick={() => setShowAddSource(true)}>
            <Plus size={14} style={{ display: 'inline', marginRight: 4 }} /> Add source
          </button>
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          7-day yield columns show how each feed performs through the funnel — high ingest with zero opportunities is a candidate for pausing.
        </div>
        <table className="lh" style={{ minWidth: 1080 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>URL / query</th>
              <th>Interval</th>
              <th>Last poll</th>
              <th>Status</th>
              <th title="Items ingested in the last 7 days">Ingested 7d</th>
              <th title="Passed the local embedding pre-filter">Candidates 7d</th>
              <th title="Made it past Claude triage as 'strong'">Strong 7d</th>
              <th title="Became full opportunities">Opps 7d</th>
              <th>Enabled</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sources.length === 0 && (
              <tr><td colSpan={12} style={{ textAlign: 'center', color: '#6b7280', padding: 28 }}>No sources yet. Turn on Live monitoring to seed defaults, or add your own.</td></tr>
            )}
            {sources.map((s) => {
              const cfg = (() => { try { return JSON.parse(s.config || '{}'); } catch { return {}; } })();
              const h = health.find((x) => x.id === s.id);
              const lowYield = h && h.ingested7d >= 20 && h.qualified7d === 0;
              return (
                <tr key={s.id}>
                  <td style={{ fontWeight: 500 }}>
                    {s.name}
                    {lowYield && (
                      <span title="20+ items ingested in 7d, 0 opportunities — consider pausing" style={{ marginLeft: 6, fontSize: 11, padding: '2px 6px', background: '#fef3c7', color: '#92400e', borderRadius: 4 }}>
                        low yield
                      </span>
                    )}
                  </td>
                  <td><span className="chip chip-muted">{s.kind}</span></td>
                  <td style={{ color: '#6b7280', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.kind === 'google_news' ? cfg.query : s.url}
                  </td>
                  <td style={{ fontSize: 12, color: '#4b5563', whiteSpace: 'nowrap' }}>{formatInterval(s.poll_interval_seconds)}</td>
                  <td style={{ fontSize: 12, color: '#4b5563', whiteSpace: 'nowrap' }}>{s.last_polled_at ? fmtDate(s.last_polled_at) : '—'}</td>
                  <td>
                    <span className={`chip ${s.last_status === 'ok' ? 'chip-qualified' : s.last_status === 'error' ? 'chip-disqualified' : 'chip-muted'}`}>
                      {s.last_status || 'pending'}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{h?.ingested7d ?? 0}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{h?.candidates7d ?? 0}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{h?.strong7d ?? 0}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: (h?.qualified7d ?? 0) > 0 ? '#065f46' : '#9ca3af' }}>{h?.qualified7d ?? 0}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={!!s.enabled}
                      onChange={async () => {
                        await window.lh.monitor.sourceUpdate(s.id, { enabled: s.enabled ? 0 : 1 });
                        refresh();
                      }}
                    />
                  </td>
                  <td>
                    <button className="btn-danger" onClick={async () => {
                      if (confirm(`Delete source "${s.name}"?`)) {
                        await window.lh.monitor.sourceDelete(s.id);
                        refresh();
                      }
                    }}><Trash2 size={13} /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Modal open={showAddSource} onClose={() => setShowAddSource(false)} title="Add Source">
        <AddSourceForm onDone={async () => { setShowAddSource(false); await refresh(); }} />
      </Modal>

      <style>{`
        .lh-pulse {
          animation: lh-pulse 1.5s infinite;
        }
        @keyframes lh-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
      `}</style>
    </div>
  );
}

function FunnelCard({ label, value, sublabel, color }: { label: string; value: number; sublabel: string; color: string }) {
  return (
    <div className="card" style={{ padding: 18 }}>
      <div className="label" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color, marginBottom: 6 }}>{value}</div>
      <div style={{ fontSize: 12, color: '#6b7280' }}>{sublabel}</div>
    </div>
  );
}

function StageChip({ status }: { status: SignalItem['status'] }) {
  const map: Record<SignalItem['status'], { label: string; cls: string }> = {
    new: { label: 'new', cls: 'chip-muted' },
    embedded: { label: 'embedded', cls: 'chip-muted' },
    candidate: { label: 'candidate', cls: 'chip-open' },
    filtered: { label: 'filtered', cls: 'chip-muted' },
    triaged_strong: { label: 'strong', cls: 'chip-qualified' },
    triaged_weak: { label: 'weak', cls: 'chip-archived' },
    triaged_rejected: { label: 'rejected', cls: 'chip-disqualified' },
    qualified: { label: 'opportunity', cls: 'chip-qualified' },
    error: { label: 'error', cls: 'chip-disqualified' }
  };
  const m = map[status] || { label: status, cls: 'chip-muted' };
  return <span className={`chip ${m.cls}`}>{m.label}</span>;
}

function formatInterval(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

function AddSourceForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'rss' | 'google_news'>('rss');
  const [url, setUrl] = useState('');
  const [query, setQuery] = useState('');
  const [intervalMin, setIntervalMin] = useState(15);

  return (
    <div>
      <label className="label">Name</label>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      <div style={{ height: 12 }} />
      <label className="label">Kind</label>
      <select className="select" value={kind} onChange={(e) => setKind(e.target.value as any)}>
        <option value="rss">RSS / Atom feed URL</option>
        <option value="google_news">Google News query</option>
      </select>
      <div style={{ height: 12 }} />
      {kind === 'rss' ? (
        <>
          <label className="label">Feed URL</label>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/feed.xml" />
        </>
      ) : (
        <>
          <label className="label">Query</label>
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder='"new CIO" OR datacenter outage' />
        </>
      )}
      <div style={{ height: 12 }} />
      <label className="label">Poll interval (minutes)</label>
      <input className="input" type="number" min={1} max={1440} value={intervalMin} onChange={(e) => setIntervalMin(Number(e.target.value))} />
      <div style={{ marginTop: 14, textAlign: 'right' }}>
        <button
          className="btn-primary"
          disabled={!name || (kind === 'rss' ? !url : !query)}
          onClick={async () => {
            await window.lh.monitor.sourceCreate({
              name,
              kind,
              url: kind === 'rss' ? url : '',
              config: kind === 'google_news' ? JSON.stringify({ query }) : null,
              enabled: 1,
              poll_interval_seconds: intervalMin * 60
            });
            onDone();
          }}
        >Save source</button>
      </div>
    </div>
  );
}
