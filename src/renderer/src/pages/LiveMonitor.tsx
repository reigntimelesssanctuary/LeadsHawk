import { useEffect, useState } from 'react';
import { Switch } from '../components/Switch';
import { Modal } from '../components/Modal';
import { ResearchSourcesModal } from '../components/ResearchSourcesModal';
import type { MonitorStatus, MonitorSource, SignalItem, SourceHealth, Settings, Brand, MonitorSourceConfig } from '../../../shared/types';
import type { Page } from '../components/Sidebar';
import { fmtDate, fmtDateSGT, openExternal } from '../lib/api';
import { Plus, Trash2, RefreshCw, AlertCircle, Radio, Inbox, Sparkles, Globe, Clock } from 'lucide-react';

export function LiveMonitor({ onOpenOpp, onNavigate }: { onOpenOpp: (id: number) => void; onNavigate?: (p: Page) => void }) {
  const [status, setStatus] = useState<MonitorStatus | null>(null);
  const [items, setItems] = useState<SignalItem[]>([]);
  const [sources, setSources] = useState<MonitorSource[]>([]);
  const [health, setHealth] = useState<SourceHealth[]>([]);
  const [spendToday, setSpendToday] = useState<number | null>(null);
  const [showAddSource, setShowAddSource] = useState(false);
  // v1.12.1: thresholds + embedding-status data for diagnostic banner
  const [settings, setSettings] = useState<Settings | null>(null);
  const [embeddingStatus, setEmbeddingStatus] = useState<Record<number, number>>({});
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  // v1.13.1: brand list (for source grouping + Research sources picker) and
  // Research sources modal target brand. null = picker not open.
  const [brands, setBrands] = useState<Brand[]>([]);
  const [researchTarget, setResearchTarget] = useState<Brand | null>(null);
  const [showResearchPicker, setShowResearchPicker] = useState(false);
  // v1.13.2: pending-suggestions summary (per-brand counts of unreviewed
  // research results) for the banner above Sources.
  const [pendingSummary, setPendingSummary] = useState<Array<{ brandId: number; count: number; createdAt: string }>>([]);

  const refresh = async () => {
    setStatus(await window.lh.monitor.status());
    setItems(await window.lh.monitor.items(80));
    setSources(await window.lh.monitor.sources());
    setHealth(await window.lh.monitor.sourcesHealth());
    try {
      const s = await window.lh.spend.summary();
      setSpendToday(s.today);
    } catch { /* spend is best-effort */ }
    try {
      setSettings(await window.lh.settings.get());
      setEmbeddingStatus(await window.lh.products.embeddingStatus());
      setBrands(await window.lh.brands.list());
      setPendingSummary(await window.lh.brands.pendingSourcesSummary());
    } catch { /* best-effort */ }
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

      {/* v1.12.1: diagnostic banner — fires when ingestion is happening but
          the embedding filter drops everything. Three potential causes with
          inline fix actions. */}
      {!bannerDismissed && (() => {
        const ingested7d = health.reduce((s, h) => s + (h.ingested7d || 0), 0);
        const candidates24h = status?.last24h.candidates ?? 0;
        const ingested24h = status?.last24h.ingested ?? 0;
        // Show if 24h shows ingest-but-no-candidates, OR if 7d aggregate
        // shows the same chronic pattern (>=20 ingested, 0 candidates).
        const showBanner =
          (ingested24h > 0 && candidates24h === 0) ||
          (ingested7d >= 20 && health.every((h) => (h.candidates7d || 0) === 0));
        if (!showBanner) return null;

        const productsWithSignalsCount = Object.keys(embeddingStatus).length;
        const productsMissingEmbeddings = Object.values(embeddingStatus).filter((c) => c === 0).length;
        const currentThreshold = settings?.embedSimilarityThreshold ?? 0.40;

        return (
          <div className="card" style={{ padding: 16, marginBottom: 20, background: '#fff7ed', border: '1px solid #fed7aa' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <AlertCircle size={20} style={{ color: '#c2410c', flexShrink: 0, marginTop: 2 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: '#7c2d12', marginBottom: 6 }}>
                  Funnel diagnostic — items are coming in but nothing's becoming a candidate
                </div>
                <div style={{ fontSize: 13, color: '#7c2d12', marginBottom: 12, lineHeight: 1.5 }}>
                  {ingested7d} items ingested over 7 days, 0 became candidates. The embedding pre-filter is dropping everything. Three usual causes, in order of likelihood:
                </div>
                <ol style={{ paddingLeft: 22, margin: 0, fontSize: 13, color: '#7c2d12', lineHeight: 1.6 }}>
                  <li style={{ marginBottom: 8 }}>
                    <b>Similarity threshold may be too strict.</b> Current value: <code style={{ background: '#fef3c7', padding: '1px 4px', borderRadius: 3 }}>{currentThreshold.toFixed(2)}</code>.
                    Most real product-signal-vs-news matches sit at 0.40–0.50.
                    {currentThreshold > 0.40 && (
                      <button
                        className="btn-ghost"
                        style={{ marginLeft: 10, fontSize: 12, padding: '2px 8px' }}
                        disabled={busyAction !== null}
                        onClick={async () => {
                          setBusyAction('threshold');
                          try {
                            await window.lh.settings.update({ embedSimilarityThreshold: 0.40 });
                            await refresh();
                          } finally { setBusyAction(null); }
                        }}
                      >
                        {busyAction === 'threshold' ? 'Lowering…' : 'Lower to 0.40'}
                      </button>
                    )}
                  </li>
                  <li style={{ marginBottom: 8 }}>
                    <b>Product signal embeddings may be missing</b> — needed for the pre-filter to match anything.
                    {productsMissingEmbeddings > 0 && productsWithSignalsCount > 0 && (
                      <span> Currently {productsMissingEmbeddings} of {productsWithSignalsCount} products have no embeddings.</span>
                    )}
                    {onNavigate && (
                      <button
                        className="btn-ghost"
                        style={{ marginLeft: 10, fontSize: 12, padding: '2px 8px' }}
                        onClick={() => onNavigate('signals')}
                      >
                        Open Signal Config →
                      </button>
                    )}
                  </li>
                  <li>
                    <b>Sources may not align with your portfolio.</b> Default seeded sources cover IT/cybersecurity well but miss other categories (real estate, banking, etc.). Look at the Sources table below — feeds with high 7d ingest but zero qualified are candidates for replacement. Auto-discovered brand-aware sources are coming in v1.13.
                  </li>
                </ol>
              </div>
              <button
                onClick={() => setBannerDismissed(true)}
                style={{ background: 'transparent', border: 'none', color: '#9a3412', cursor: 'pointer', fontSize: 12, padding: 4 }}
                title="Hide until next reload"
              >
                Dismiss
              </button>
            </div>
          </div>
        );
      })()}

      <ManualIntakeCard onDone={refresh} onOpenOpp={onOpenOpp} />

      {/* v1.13.3: Sources moved above Recent items — sources are the
          configuration surface, items are the resulting stream. Putting
          configuration first matches the user's mental model. */}
      <div className="card" style={{ padding: 20, overflowX: 'auto' }}>
        {/* v1.13.2: pending-suggestions banner — shows when research finished
            but suggestions haven't been reviewed yet (e.g. modal was closed
            mid-research or before user clicked Add). */}
        {pendingSummary.length > 0 && (
          <div style={{ marginBottom: 14, padding: 12, background: '#ede9fe', border: '1px solid #c4b5fd', borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <Sparkles size={18} style={{ color: '#6c5cf2', flexShrink: 0, marginTop: 2 }} />
              <div style={{ flex: 1, fontSize: 13, color: '#4c1d95' }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  Source suggestions ready to review
                </div>
                {pendingSummary.map((p) => {
                  const brand = brands.find((b) => b.id === p.brandId);
                  if (!brand) return null;
                  return (
                    <div key={p.brandId} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                      <span><b>{brand.name}</b>: {p.count} suggestion{p.count === 1 ? '' : 's'}</span>
                      <button
                        className="btn-ghost"
                        style={{ fontSize: 12, padding: '2px 8px' }}
                        onClick={() => setResearchTarget(brand)}
                      >
                        Review →
                      </button>
                      <button
                        className="btn-ghost"
                        style={{ fontSize: 12, padding: '2px 8px', color: '#9ca3af' }}
                        onClick={async () => {
                          await window.lh.brands.dismissPendingSources(p.brandId);
                          refresh();
                        }}
                        title="Discard these suggestions without reviewing"
                      >
                        Dismiss
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, flexWrap: 'wrap', gap: 8 }}>
          <div className="h-section">Sources</div>
          <div style={{ display: 'flex', gap: 6, position: 'relative' }}>
            <button
              className="btn-ghost"
              onClick={() => setShowResearchPicker((v) => !v)}
              title="Auto-discover RSS + Google News sources aligned with a brand's signals."
            >
              <Sparkles size={14} style={{ display: 'inline', marginRight: 4 }} /> Research sources
            </button>
            {showResearchPicker && (
              <div
                style={{
                  position: 'absolute',
                  top: 36,
                  right: 130,
                  zIndex: 50,
                  background: 'white',
                  border: '1px solid #e5e7eb',
                  borderRadius: 8,
                  boxShadow: '0 6px 24px rgba(0,0,0,0.12)',
                  minWidth: 240,
                  padding: 8
                }}
              >
                <div style={{ fontSize: 11, color: '#6b7280', padding: '4px 8px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Pick a brand
                </div>
                {brands.filter((b) => b.research_status === 'ready').length === 0 ? (
                  <div style={{ padding: 12, fontSize: 13, color: '#6b7280' }}>
                    Run brand research first (Brands &amp; Products tab) — source research needs the brand dossier as context.
                  </div>
                ) : (
                  brands.filter((b) => b.research_status === 'ready').map((b) => (
                    <button
                      key={b.id}
                      onClick={() => {
                        setResearchTarget(b);
                        setShowResearchPicker(false);
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 10px',
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        fontSize: 14,
                        borderRadius: 6
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#f3f4ff')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      {b.name}
                    </button>
                  ))
                )}
              </div>
            )}
            <button className="btn-ghost" onClick={() => setShowAddSource(true)}>
              <Plus size={14} style={{ display: 'inline', marginRight: 4 }} /> Add source
            </button>
          </div>
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          Sources grouped by which brand they serve. 7-day yield columns show how each feed performs through the funnel — high ingest with zero opportunities is a candidate for pausing.
        </div>

        {(() => {
          // v1.13.1: group sources into per-brand / common / unassigned.
          const groups = groupSourcesByBrand(sources, brands);
          if (sources.length === 0) {
            return <div style={{ padding: 28, textAlign: 'center', color: '#6b7280' }}>No sources yet. Turn on Live monitoring to seed defaults, click <b>Research sources</b> for brand-aligned auto-discovery, or add your own with <b>Add source</b>.</div>;
          }
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {groups.perBrand.map((g) => (
                <SourceGroup
                  key={`brand-${g.brand.id}`}
                  title={g.brand.name}
                  subtitle={`${g.sources.length} source${g.sources.length === 1 ? '' : 's'} discovered for this brand`}
                  sources={g.sources}
                  health={health}
                  brands={brands}
                  showBrandPills={false}
                  onChanged={refresh}
                  onResearchMore={() => setResearchTarget(g.brand)}
                />
              ))}
              {groups.common.length > 0 && (
                <SourceGroup
                  title="Common sources"
                  subtitle={`${groups.common.length} source${groups.common.length === 1 ? '' : 's'} serving multiple brands`}
                  sources={groups.common}
                  health={health}
                  brands={brands}
                  showBrandPills={true}
                  onChanged={refresh}
                />
              )}
              {groups.unassigned.length > 0 && (
                <SourceGroup
                  title="Unassigned"
                  subtitle={`${groups.unassigned.length} source${groups.unassigned.length === 1 ? '' : 's'} not tagged to any brand (default seeded or manually added)`}
                  sources={groups.unassigned}
                  health={health}
                  brands={brands}
                  showBrandPills={false}
                  onChanged={refresh}
                />
              )}
            </div>
          );
        })()}
      </div>

      {/* v1.13.3: Recent items now lives below Sources. */}
      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 20, marginTop: 20 }}>
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

      <Modal open={showAddSource} onClose={() => setShowAddSource(false)} title="Add Source">
        <AddSourceForm onDone={async () => { setShowAddSource(false); await refresh(); }} />
      </Modal>

      {/* v1.13.1: ResearchSourcesModal target is set by the brand picker dropdown. */}
      {researchTarget && (
        <ResearchSourcesModal
          open={!!researchTarget}
          onClose={() => { setResearchTarget(null); refresh(); }}
          brandId={researchTarget.id}
          brandName={researchTarget.name}
          onCompleted={refresh}
        />
      )}

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

type IntakeOutcome =
  | { kind: 'filtered'; reason: string; similarity: number }
  | { kind: 'triaged'; decision: 'rejected' | 'weak'; reason: string; similarity: number }
  | { kind: 'qualified'; opportunityId: number; confidence: number }
  | { kind: 'error'; error: string };

function ManualIntakeCard({ onDone, onOpenOpp }: { onDone: () => void; onOpenOpp: (id: number) => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ outcome: IntakeOutcome; itemId: number } | null>(null);

  const submit = async () => {
    if (!url.trim() || busy) return;
    setBusy(true); setResult(null);
    try {
      const r = await window.lh.monitor.intake({ url: url.trim() });
      setResult(r);
      setUrl('');
      onDone();
    } catch (e: any) {
      setResult({ itemId: 0, outcome: { kind: 'error', error: e?.message || String(e) } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ padding: 18, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <Inbox size={16} style={{ color: '#6c5cf2' }} />
        <div className="h-section" style={{ flex: 1 }}>Manual intake</div>
      </div>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
        Paste a URL you've seen externally. LeadsHawk will fetch it, embed it, match against every product's signals, and (if it survives triage) run a deep qualify. Same pipeline as RSS items — just one-at-a-time, on demand.
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="https://example.com/article-or-press-release"
          disabled={busy}
        />
        <button className="btn-primary" onClick={submit} disabled={!url.trim() || busy}>
          {busy ? 'Processing…' : 'Run through pipeline'}
        </button>
      </div>
      {result && <IntakeResultBanner result={result} onOpenOpp={onOpenOpp} />}
    </div>
  );
}

function IntakeResultBanner({
  result, onOpenOpp
}: {
  result: { outcome: IntakeOutcome; itemId: number };
  onOpenOpp: (id: number) => void;
}) {
  const { outcome } = result;
  const style = (bg: string, border: string, fg: string) => ({
    marginTop: 12, padding: '10px 14px', background: bg, border: `1px solid ${border}`,
    borderRadius: 8, fontSize: 13, color: fg, lineHeight: 1.45
  });
  if (outcome.kind === 'qualified') {
    return (
      <div style={style('#ecfdf5', '#a7f3d0', '#065f46')}>
        ✓ <b>Opportunity created</b> ({Math.round((outcome.confidence || 0) * 100)}% confidence).{' '}
        <button className="btn-ghost" style={{ marginLeft: 6, padding: '2px 8px', fontSize: 12 }} onClick={() => onOpenOpp(outcome.opportunityId)}>
          Open
        </button>
      </div>
    );
  }
  if (outcome.kind === 'triaged') {
    return (
      <div style={style('#fef3c7', '#fde68a', '#92400e')}>
        Triaged <b>{outcome.decision}</b> — {outcome.reason} (pre-filter sim {outcome.similarity.toFixed(2)})
      </div>
    );
  }
  if (outcome.kind === 'filtered') {
    return (
      <div style={style('#f3f4f6', '#e5e7eb', '#4b5563')}>
        Filtered at pre-filter — {outcome.reason}
      </div>
    );
  }
  return (
    <div style={style('#fef2f2', '#fecaca', '#991b1b')}>
      Error: {outcome.error}
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

// v1.13.1: parse a source's config JSON safely.
function parseSourceConfig(raw: string | null): MonitorSourceConfig {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// v1.13.1: group sources for the Live Monitor Sources card.
// Pure function — exported for smoke testing.
export type SourceGrouping = {
  perBrand: Array<{ brand: Brand; sources: MonitorSource[] }>;
  common: MonitorSource[];
  unassigned: MonitorSource[];
};
export function groupSourcesByBrand(sources: MonitorSource[], brands: Brand[]): SourceGrouping {
  const perBrandMap = new Map<number, MonitorSource[]>();
  const common: MonitorSource[] = [];
  const unassigned: MonitorSource[] = [];
  for (const s of sources) {
    const cfg = parseSourceConfig(s.config);
    const ids = Array.isArray(cfg.serves_brand_ids) ? cfg.serves_brand_ids : [];
    if (ids.length === 0) {
      unassigned.push(s);
    } else if (ids.length === 1) {
      const bid = ids[0];
      if (!perBrandMap.has(bid)) perBrandMap.set(bid, []);
      perBrandMap.get(bid)!.push(s);
    } else {
      common.push(s);
    }
  }
  // Sort each brand's sources by name.
  const perBrand: SourceGrouping['perBrand'] = [];
  for (const b of brands) {
    const list = perBrandMap.get(b.id);
    if (list && list.length > 0) {
      list.sort((a, b) => a.name.localeCompare(b.name));
      perBrand.push({ brand: b, sources: list });
    }
  }
  // Any orphan brand-id (brand was deleted) → its sources fall to common.
  for (const [bid, list] of perBrandMap.entries()) {
    if (!brands.find((b) => b.id === bid)) {
      common.push(...list);
    }
  }
  common.sort((a, b) => a.name.localeCompare(b.name));
  unassigned.sort((a, b) => a.name.localeCompare(b.name));
  return { perBrand, common, unassigned };
}

// v1.13.1: pretty time-remaining label for trial sources.
function trialTimeLabel(trialUntil: string | null): { label: string; expired: boolean } | null {
  if (!trialUntil) return null;
  // SQLite stores UTC without 'Z' suffix.
  const t = new Date(trialUntil.replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(t)) return null;
  const diffMs = t - Date.now();
  if (diffMs < 0) return { label: 'expired', expired: true };
  const hours = Math.floor(diffMs / 3600_000);
  if (hours < 24) return { label: `${hours}h left`, expired: false };
  const days = Math.floor(hours / 24);
  return { label: `${days}d left`, expired: false };
}

function SourceGroup({
  title, subtitle, sources, health, brands, showBrandPills, onChanged, onResearchMore
}: {
  title: string;
  subtitle: string;
  sources: MonitorSource[];
  health: SourceHealth[];
  brands: Brand[];
  showBrandPills: boolean;
  onChanged: () => void;
  onResearchMore?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: '#fafafa', borderBottom: collapsed ? 'none' : '1px solid #e5e7eb' }}>
        <button onClick={() => setCollapsed((v) => !v)} style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, flex: 1, textAlign: 'left' }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>{collapsed ? '▶' : '▼'}</span>
          <span style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>{title}</span>
          <span style={{ fontSize: 12, color: '#6b7280' }}>· {subtitle}</span>
        </button>
        {onResearchMore && (
          <button className="btn-ghost" style={{ fontSize: 12, padding: '3px 10px' }} onClick={onResearchMore}>
            <Sparkles size={12} style={{ display: 'inline', marginRight: 4 }} /> Discover more
          </button>
        )}
      </div>
      {!collapsed && (
        <table className="lh" style={{ minWidth: 1080 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>URL / query</th>
              {showBrandPills && <th>Serves</th>}
              <th>Trial</th>
              <th>Last poll</th>
              <th>Status</th>
              <th title="Items ingested in the last 7 days">Ing 7d</th>
              <th title="Passed the local embedding pre-filter">Cand 7d</th>
              <th title="Made it past Claude triage as 'strong'">Strong 7d</th>
              <th title="Became full opportunities">Opps 7d</th>
              <th>On</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => {
              const cfg = parseSourceConfig(s.config);
              const h = health.find((x) => x.id === s.id);
              const lowYield = h && h.ingested7d >= 20 && h.qualified7d === 0;
              const trial = trialTimeLabel(s.trial_until);
              const servesBrands = (cfg.serves_brand_ids || [])
                .map((id) => brands.find((b) => b.id === id))
                .filter((b): b is Brand => !!b);
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
                  <td style={{ color: '#6b7280', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.kind === 'google_news' ? (cfg.query || s.url) : s.url}
                  </td>
                  {showBrandPills && (
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {servesBrands.map((b) => (
                          <span key={b.id} className="chip chip-brand" style={{ fontSize: 10, padding: '1px 6px' }}>{b.name}</span>
                        ))}
                      </div>
                    </td>
                  )}
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {!trial ? (
                      <span style={{ fontSize: 11, color: '#9ca3af' }}>—</span>
                    ) : trial.expired ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span className="chip chip-disqualified" style={{ fontSize: 10, padding: '1px 6px' }}>expired</span>
                        <button
                          className="btn-ghost"
                          style={{ fontSize: 11, padding: '2px 6px' }}
                          onClick={async () => { await window.lh.monitor.extendTrial(s.id, 7); onChanged(); }}
                          title="Extend trial by 7 days"
                        >
                          Extend
                        </button>
                        <button
                          className="btn-ghost"
                          style={{ fontSize: 11, padding: '2px 6px' }}
                          onClick={async () => { await window.lh.monitor.promoteTrial(s.id); onChanged(); }}
                          title="Promote to permanent (no trial)"
                        >
                          Keep
                        </button>
                      </span>
                    ) : (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span className="chip chip-open" style={{ fontSize: 10, padding: '1px 6px' }} title={`Trial expires ${s.trial_until}`}>
                          <Clock size={10} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 2 }} />
                          {trial.label}
                        </span>
                        <button
                          className="btn-ghost"
                          style={{ fontSize: 11, padding: '2px 6px' }}
                          onClick={async () => { await window.lh.monitor.promoteTrial(s.id); onChanged(); }}
                          title="Promote to permanent now (skip trial)"
                        >
                          Keep
                        </button>
                      </span>
                    )}
                  </td>
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
                        onChanged();
                      }}
                    />
                  </td>
                  <td>
                    <button className="btn-danger" onClick={async () => {
                      if (confirm(`Delete source "${s.name}"?`)) {
                        await window.lh.monitor.sourceDelete(s.id);
                        onChanged();
                      }
                    }}><Trash2 size={13} /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
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
