import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { FeedbackModal } from '../components/FeedbackModal';
import type { FeedbackTargetKind } from '../../../shared/types';
type SignalFeedbackKind = Extract<FeedbackTargetKind, 'brand_signals' | 'product_signals'>;
import type { SignalSource, Product, Brand, ScanRule } from '../../../shared/types';
import {
  Plus, Trash2, Sparkles, ChevronDown, ChevronRight,
  AlertCircle, CheckCircle2, Ban, Globe, MessageSquare, RefreshCw
} from 'lucide-react';

export function SignalConfig() {
  const [products, setProducts] = useState<Product[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [sources, setSources] = useState<SignalSource[]>([]);
  const [globalRules, setGlobalRules] = useState<ScanRule[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [globalOpen, setGlobalOpen] = useState(false);
  // v1.9.2: per-row "research signals" busy state, keyed by `${kind}-${id}`.
  const [busy, setBusy] = useState<string | null>(null);
  // v1.9.2: feedback modal target. null = closed.
  const [feedbackTarget, setFeedbackTarget] = useState<
    { kind: SignalFeedbackKind; id: number; name: string } | null
  >(null);
  // v1.12.1: per-product embedding vector count (0 = signals present but
  // embeddings haven't been computed yet → Live Monitor can't match).
  const [embeddingStatus, setEmbeddingStatus] = useState<Record<number, number>>({});

  const refresh = async () => {
    const [prods, brs, srcs, rules, embStatus] = await Promise.all([
      window.lh.products.list(),
      window.lh.brands.list(),
      window.lh.sources.list(),
      window.lh.rules.listGlobal(),
      window.lh.products.embeddingStatus().catch(() => ({} as Record<number, number>))
    ]);
    setProducts(prods);
    setBrands(brs);
    setSources(srcs);
    setGlobalRules(rules);
    setEmbeddingStatus(embStatus);
  };
  useEffect(() => { refresh(); }, []);

  const embedNow = async (p: Product) => {
    const key = `embed-${p.id}`;
    setBusy(key);
    try { await window.lh.products.reembed(p.id); await refresh(); }
    catch (e: any) { alert(e.message); }
    finally { setBusy(null); }
  };

  const researchBrandSignals = async (b: Brand) => {
    const key = `brand-${b.id}`;
    setBusy(key);
    try { await window.lh.brands.researchSignals(b.id); await refresh(); }
    catch (e: any) { alert(e.message); }
    finally { setBusy(null); }
  };
  const researchProductSignals = async (p: Product) => {
    const key = `product-${p.id}`;
    setBusy(key);
    try { await window.lh.products.researchSignals(p.id); await refresh(); }
    catch (e: any) { alert(e.message); }
    finally { setBusy(null); }
  };

  const loadGlobalRules = async () => setGlobalRules(await window.lh.rules.listGlobal());

  const toggleProduct = async (p: Product) => {
    await window.lh.products.setScanEnabled(p.id, p.scan_enabled ? false : true);
    refresh();
  };

  const toggleSource = async (s: SignalSource) => {
    await window.lh.sources.update(s.id, { enabled: s.enabled ? 0 : 1 });
    refresh();
  };

  // v1.10.3: dropped the `&& p.signals` requirement. v1.9.2 decoupled
  // signal research from dossier research, so a freshly-researched product
  // has research_status='ready' but signals=null until the user clicks
  // Research signals here. The old filter hid such products entirely.
  const productsReady = products.filter((p) => p.research_status === 'ready');
  const productsNotReady = products.filter((p) => p.research_status !== 'ready');

  return (
    <div>
      <div style={{ marginTop: 16, marginBottom: 16 }}>
        <div className="h-page">Signal Config</div>
        <div style={{ color: '#6b7280', fontSize: 14, marginTop: 4 }}>
          LeadsHawk scans the web for the buying signals it learned from your product research.
          Expand a product to see its signals and set include / exclude rules.
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <button
          onClick={() => setGlobalOpen(!globalOpen)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', width: '100%', textAlign: 'left' }}
        >
          {globalOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <Globe size={16} style={{ color: '#6c5cf2' }} />
          <span className="h-section">Global rules</span>
          <span style={{ marginLeft: 'auto', color: '#6b7280', fontSize: 13 }}>
            {globalRules.length} rule{globalRules.length === 1 ? '' : 's'}
          </span>
        </button>
        {globalOpen && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
              Hard constraints applied to <b>every</b> scan — across all products, custom topics, and the live monitor. Use these for things like geography, company-size floors, or industries you never sell into.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <RuleColumn
                kind="include"
                icon={<CheckCircle2 size={15} style={{ color: '#065f46' }} />}
                title="Always include"
                accent="#065f46"
                accentBg="#ecfdf5"
                accentBorder="#a7f3d0"
                placeholder="e.g. US-headquartered companies only"
                rules={globalRules.filter((r) => r.kind === 'include')}
                onAdd={async (text) => { await window.lh.rules.createGlobal({ kind: 'include', text }); }}
                refresh={loadGlobalRules}
              />
              <RuleColumn
                kind="exclude"
                icon={<Ban size={15} style={{ color: '#991b1b' }} />}
                title="Always exclude"
                accent="#991b1b"
                accentBg="#fef2f2"
                accentBorder="#fecaca"
                placeholder="e.g. companies under 50 employees"
                rules={globalRules.filter((r) => r.kind === 'exclude')}
                onAdd={async (text) => { await window.lh.rules.createGlobal({ kind: 'exclude', text }); }}
                refresh={loadGlobalRules}
              />
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div className="h-section" style={{ marginBottom: 6 }}>
          <Sparkles size={16} style={{ display: 'inline', marginRight: 8, verticalAlign: '-2px', color: '#6c5cf2' }} />
          Brand-level signals
        </div>
        <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
          Cross-cutting events that indicate ANY product from a brand may be needed (e.g. an APAC HQ relocation, lease renewals, post-M&A IT consolidation). Run signal research per brand to populate. Use "Re-research with feedback" when a brand owner reviews the dossier and asks for changes.
        </div>
        {brands.length === 0 ? (
          <div style={{ color: '#6b7280', fontSize: 13 }}>No brands yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {brands.map((b) => {
              const lines = parseBullets(b.signals || '');
              const researched = b.research_status === 'ready';
              const hasSignals = lines.length > 0;
              const busyKey = `brand-${b.id}`;
              const isBusy = busy === busyKey;
              return (
                <div key={b.id} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, background: researched ? 'white' : '#fafafa' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 200 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{b.name}</div>
                      {!researched ? (
                        <span className="chip chip-muted" title="Run brand research from Brands & Products first.">brand not researched yet</span>
                      ) : !hasSignals ? (
                        <span className="chip chip-muted">no signals yet</span>
                      ) : (
                        <span className="chip chip-qualified">{lines.length} signal{lines.length === 1 ? '' : 's'}</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="btn-ghost"
                        onClick={() => researchBrandSignals(b)}
                        disabled={!researched || !!busy}
                        title={researched ? 'Run signal research for this brand (Perplexity sonar-pro, cheap).' : 'Run brand research first from Brands & Products.'}
                      >
                        {hasSignals ? <RefreshCw size={13} style={{ display: 'inline', marginRight: 4 }} /> : <Sparkles size={13} style={{ display: 'inline', marginRight: 4 }} />}
                        {isBusy ? 'Researching…' : (hasSignals ? 'Re-research signals' : 'Research signals')}
                      </button>
                      <button
                        className="btn-ghost"
                        onClick={() => setFeedbackTarget({ kind: 'brand_signals', id: b.id, name: b.name })}
                        disabled={!researched || !!busy}
                        title="Re-research signals while injecting reviewer feedback into the prompt."
                      >
                        <MessageSquare size={13} style={{ display: 'inline', marginRight: 4 }} />
                        Re-research with feedback
                      </button>
                    </div>
                  </div>
                  {hasSignals && (
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#1f2937', lineHeight: 1.5 }}>
                      {lines.map((line, i) => <li key={i} style={{ marginBottom: 2 }}>{line}</li>)}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div className="h-section" style={{ marginBottom: 12 }}>
          <Sparkles size={16} style={{ display: 'inline', marginRight: 8, verticalAlign: '-2px', color: '#6c5cf2' }} />
          Product-level signals
        </div>

        {productsReady.length === 0 ? (
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: 16, background: '#fff7ed', borderRadius: 8 }}>
            <AlertCircle size={20} style={{ color: '#c2410c', flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: 14, color: '#7c2d12' }}>
              No researched products yet. Go to <b>Brands & Products</b>, add at least one product, and click <b>Run research</b>. LeadsHawk will then know what signals to watch for.
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {productsReady.map((p) => {
              const brand = brands.find((b) => b.id === p.brand_id);
              const busyKey = `product-${p.id}`;
              return (
                <ProductSignals
                  key={p.id}
                  product={p}
                  brandName={brand?.name || ''}
                  onToggle={() => toggleProduct(p)}
                  onResearchSignals={() => researchProductSignals(p)}
                  onResearchSignalsWithFeedback={() =>
                    setFeedbackTarget({ kind: 'product_signals', id: p.id, name: p.name })
                  }
                  isBusy={busy === busyKey}
                  anyBusy={busy !== null}
                  embeddingCount={embeddingStatus[p.id] ?? 0}
                  isEmbedding={busy === `embed-${p.id}`}
                  onEmbedNow={() => embedNow(p)}
                />
              );
            })}
          </div>
        )}

        {productsNotReady.length > 0 && (
          <div style={{ marginTop: 14, fontSize: 13, color: '#6b7280' }}>
            <b>{productsNotReady.length}</b> product{productsNotReady.length === 1 ? '' : 's'} need dossier research before signal research can run —
            go to <b>Brands &amp; Products</b> and click <b>Run research</b> on {productsNotReady.length === 1 ? 'it' : 'them'} first.
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 20, background: '#fafafa' }}>
        <button
          onClick={() => setAdvancedOpen(!advancedOpen)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', width: '100%', textAlign: 'left' }}
        >
          {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <span className="h-section" style={{ color: '#6b7280' }}>Advanced — custom topics</span>
          <span className="chip chip-muted" style={{ marginLeft: 8 }}>retired in v1.12</span>
          <span style={{ marginLeft: 'auto', color: '#6b7280', fontSize: 13 }}>
            {sources.length} configured
          </span>
        </button>

        {advancedOpen && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 13, color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a', padding: '10px 12px', borderRadius: 8, marginBottom: 14 }}>
              Custom topics ran only via the manual scan, which was retired in v1.12 in favour of the higher-quality two-stage deep scan. Your existing topics are preserved in the database for reference, but they don't fire on any scan or live monitor today. You can delete topics you no longer need, or leave them as a record of past intent.
            </div>

            {sources.length > 0 && (
              <div className="card" style={{ overflow: 'hidden', marginBottom: 12, boxShadow: 'none' }}>
                <table className="lh">
                  <thead>
                    <tr>
                      <th>Topic</th>
                      <th>Query</th>
                      <th>Pinned to</th>
                      <th>Enabled</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sources.map((s) => {
                      const cfg = (() => { try { return JSON.parse(s.config || '{}'); } catch { return {}; } })();
                      const pinned = typeof cfg.pinnedProductId === 'number'
                        ? products.find((p) => p.id === cfg.pinnedProductId)
                        : null;
                      return (
                        <tr key={s.id}>
                          <td style={{ fontWeight: 500 }}>{s.name}</td>
                          <td style={{ color: '#6b7280', maxWidth: 380 }}>{cfg.query || cfg.url || ''}</td>
                          <td style={{ fontSize: 12 }}>
                            {pinned ? (
                              <span className="chip chip-brand" title="Inherits this product's scan rules">{pinned.name}</span>
                            ) : (
                              <span style={{ color: '#9ca3af' }}>—</span>
                            )}
                          </td>
                          <td>
                            <input type="checkbox" checked={!!s.enabled} onChange={() => toggleSource(s)} />
                          </td>
                          <td>
                            <button className="btn-danger" onClick={async () => {
                              if (confirm('Delete topic?')) { await window.lh.sources.delete(s.id); refresh(); }
                            }}><Trash2 size={13} /></button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <button className="btn-ghost" onClick={() => setShowAdd(true)}>
              <Plus size={14} style={{ display: 'inline', marginRight: 6 }} /> Add custom topic
            </button>
          </div>
        )}
      </div>

      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add Custom Topic">
        <AddSourceForm products={products} onDone={async () => { setShowAdd(false); refresh(); }} />
      </Modal>

      {feedbackTarget && (
        <FeedbackModal
          open={!!feedbackTarget}
          onClose={() => setFeedbackTarget(null)}
          kind={feedbackTarget.kind}
          targetId={feedbackTarget.id}
          targetName={feedbackTarget.name}
          onCompleted={refresh}
        />
      )}
    </div>
  );
}

function ProductSignals({
  product, brandName, onToggle,
  onResearchSignals, onResearchSignalsWithFeedback, isBusy, anyBusy,
  embeddingCount, isEmbedding, onEmbedNow
}: {
  product: Product; brandName: string; onToggle: () => void;
  onResearchSignals: () => void;
  onResearchSignalsWithFeedback: () => void;
  isBusy: boolean;
  anyBusy: boolean;
  // v1.12.1
  embeddingCount: number;
  isEmbedding: boolean;
  onEmbedNow: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [rules, setRules] = useState<ScanRule[]>([]);
  const signalLines = parseBullets(product.signals || '');
  const enabled = product.scan_enabled === 1;
  const hasSignals = signalLines.length > 0;

  const loadRules = async () => setRules(await window.lh.rules.list(product.id));
  useEffect(() => { if (expanded) loadRules(); }, [expanded]);

  const includes = rules.filter((r) => r.kind === 'include');
  const excludes = rules.filter((r) => r.kind === 'exclude');

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, background: enabled ? 'white' : '#fafafa' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={onToggle}
            style={{ marginRight: 8, transform: 'scale(1.1)' }}
          />
        </label>
        <button
          onClick={() => setExpanded(!expanded)}
          style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', minWidth: 200 }}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              {product.name}
              <span style={{ color: '#6b7280', fontWeight: 400 }}> · {brandName}</span>
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span>{hasSignals ? `${signalLines.length} signal${signalLines.length === 1 ? '' : 's'} ${enabled ? 'tracked' : 'paused'}` : 'no signals yet'}</span>
              {/* v1.12.1: embedding status indicator. Critical because Live
                  Monitor's pre-filter ONLY works when embeddings exist. */}
              {hasSignals && embeddingCount > 0 && (
                <span
                  className="chip chip-qualified"
                  style={{ fontSize: 10, padding: '1px 6px' }}
                  title={`${embeddingCount} signal vectors persisted — Live Monitor's pre-filter can match against this product.`}
                >
                  ✓ embedded ({embeddingCount})
                </span>
              )}
              {hasSignals && embeddingCount === 0 && (
                <>
                  <span
                    className="chip"
                    style={{ fontSize: 10, padding: '1px 6px', background: '#fef3c7', color: '#92400e' }}
                    title="Signals exist but vector embeddings haven't been computed. Live Monitor can't match against this product until embeddings are populated."
                  >
                    ⚠ needs embedding
                  </span>
                  <button
                    className="btn-ghost"
                    onClick={(e) => { e.stopPropagation(); onEmbedNow(); }}
                    disabled={anyBusy}
                    style={{ fontSize: 11, padding: '2px 8px' }}
                  >
                    {isEmbedding ? 'Embedding…' : 'Embed now'}
                  </button>
                </>
              )}
            </div>
          </div>
        </button>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="btn-ghost"
            onClick={onResearchSignals}
            disabled={anyBusy}
            title="Run signal research for this product (Perplexity sonar-pro, ~$0.01)."
          >
            {hasSignals ? <RefreshCw size={13} style={{ display: 'inline', marginRight: 4 }} /> : <Sparkles size={13} style={{ display: 'inline', marginRight: 4 }} />}
            {isBusy ? 'Researching…' : (hasSignals ? 'Re-research signals' : 'Research signals')}
          </button>
          <button
            className="btn-ghost"
            onClick={onResearchSignalsWithFeedback}
            disabled={anyBusy}
            title="Re-research signals while injecting reviewer feedback into the prompt."
          >
            <MessageSquare size={13} style={{ display: 'inline', marginRight: 4 }} />
            Re-research with feedback
          </button>
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed #e5e7eb' }}>
          <div className="label" style={{ marginBottom: 6 }}>Signals to watch for</div>
          {signalLines.length === 0 ? (
            <div style={{ color: '#6b7280', fontSize: 13 }}>No signals yet. Click <b>Research signals</b> above to populate.</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#1f2937', lineHeight: 1.6 }}>
              {signalLines.map((line, i) => (
                <li key={i} style={{ marginBottom: 4 }}>{line}</li>
              ))}
            </ul>
          )}
          <div style={{ marginTop: 8, fontSize: 12, color: '#6b7280' }}>
            To change these signals, use the <b>Research signals</b> or <b>Re-research with feedback</b> buttons above. Dossier re-research from Brands &amp; Products no longer touches signals.
          </div>

          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px dashed #e5e7eb' }}>
            <div className="label" style={{ marginBottom: 4 }}>Scan guidance for this product</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
              Hard constraints applied whenever LeadsHawk scans for <b>{product.name}</b>.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <RuleColumn
                kind="include"
                icon={<CheckCircle2 size={15} style={{ color: '#065f46' }} />}
                title="Always include"
                accent="#065f46"
                accentBg="#ecfdf5"
                accentBorder="#a7f3d0"
                placeholder="e.g. publicly traded companies only"
                rules={includes}
                onAdd={async (text) => { await window.lh.rules.create({ productId: product.id, kind: 'include', text }); }}
                refresh={loadRules}
              />
              <RuleColumn
                kind="exclude"
                icon={<Ban size={15} style={{ color: '#991b1b' }} />}
                title="Always exclude"
                accent="#991b1b"
                accentBg="#fef2f2"
                accentBorder="#fecaca"
                placeholder="e.g. consulting firms"
                rules={excludes}
                onAdd={async (text) => { await window.lh.rules.create({ productId: product.id, kind: 'exclude', text }); }}
                refresh={loadRules}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RuleColumn({
  kind, icon, title, accent, accentBg, accentBorder, placeholder, rules, onAdd, refresh
}: {
  kind: 'include' | 'exclude';
  icon: React.ReactNode;
  title: string;
  accent: string;
  accentBg: string;
  accentBorder: string;
  placeholder: string;
  rules: ScanRule[];
  onAdd: (text: string) => Promise<void>;
  refresh: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // kind is referenced by callers via add(); satisfy noUnusedLocals.
  void kind;

  const add = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await onAdd(trimmed);
      setText('');
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, color: accent, fontWeight: 600, fontSize: 13 }}>
        {icon} {title}
        <span style={{ marginLeft: 'auto', color: '#6b7280', fontWeight: 400, fontSize: 12 }}>
          {rules.length}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
        {rules.length === 0 && (
          <div style={{ color: '#9ca3af', fontSize: 12, fontStyle: 'italic', padding: '2px 0' }}>
            No rules yet.
          </div>
        )}
        {rules.map((r) => (
          <div
            key={r.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 9px',
              borderRadius: 8,
              background: r.enabled ? accentBg : '#f9fafb',
              border: `1px solid ${r.enabled ? accentBorder : '#e5e7eb'}`,
              opacity: r.enabled ? 1 : 0.6
            }}
          >
            <input
              type="checkbox"
              checked={!!r.enabled}
              onChange={async () => {
                await window.lh.rules.update(r.id, { enabled: r.enabled ? 0 : 1 });
                refresh();
              }}
              title={r.enabled ? 'Active' : 'Paused'}
            />
            <div style={{ flex: 1, fontSize: 13, color: '#1f2937', lineHeight: 1.4 }}>{r.text}</div>
            <button
              onClick={async () => {
                if (confirm('Delete this rule?')) {
                  await window.lh.rules.delete(r.id);
                  refresh();
                }
              }}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 2 }}
              title="Delete"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <input
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) add(); }}
          placeholder={placeholder}
          style={{ flex: 1, fontSize: 13 }}
        />
        <button
          className="btn-ghost"
          onClick={add}
          disabled={!text.trim() || busy}
          style={{ whiteSpace: 'nowrap' }}
        >
          <Plus size={14} style={{ display: 'inline', marginRight: 4, verticalAlign: '-2px' }} />
          Add
        </button>
      </div>
    </div>
  );
}

function parseBullets(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter((l) => l.length > 0);
}

function AddSourceForm({ products, onDone }: { products: Product[]; onDone: () => void }) {
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [pinnedProductId, setPinnedProductId] = useState<number | ''>('');
  return (
    <div>
      <label className="label">Topic name</label>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Healthcare data breaches" />
      <div style={{ height: 12 }} />
      <label className="label">Search query</label>
      <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. healthcare ransomware OR patient data breach" />
      <div style={{ height: 12 }} />
      <label className="label">Apply rules from product (optional)</label>
      <select
        className="select"
        value={pinnedProductId === '' ? '' : String(pinnedProductId)}
        onChange={(e) => setPinnedProductId(e.target.value === '' ? '' : Number(e.target.value))}
      >
        <option value="">— none (global rules only) —</option>
        {products.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>
        LeadsHawk will search the web for this topic on every scan, in addition to the auto-derived signals from your products. If you pin a product, that product's include/exclude rules are applied to this topic's results.
      </div>
      <div style={{ marginTop: 14, textAlign: 'right' }}>
        <button className="btn-primary" disabled={!name || !query} onClick={async () => {
          const cfg: Record<string, any> = { query };
          if (pinnedProductId !== '') cfg.pinnedProductId = pinnedProductId;
          await window.lh.sources.create({
            name,
            kind: 'query',
            config: JSON.stringify(cfg),
            enabled: 1
          });
          onDone();
        }}>Save topic</button>
      </div>
    </div>
  );
}
