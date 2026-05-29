import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { FeedbackModal } from '../components/FeedbackModal';
import type { FeedbackTargetKind } from '../../../shared/types';
type SignalFeedbackKind = Extract<FeedbackTargetKind, 'brand_signals' | 'product_signals'>;
import type { SignalSource, Product, Brand, ScanRule } from '../../../shared/types';
import {
  parseSignalsBlob,
  serializeSignals,
  parseLockedSignals,
  serializeLockedSignals,
  renameLockedSignal,
  removeLockedSignal
} from '../../../shared/signals';
import {
  Plus, Trash2, Sparkles, ChevronDown, ChevronRight,
  AlertCircle, CheckCircle2, Ban, Globe, MessageSquare, RefreshCw,
  Lock, Unlock, Pencil, Check, X
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
          Click any signal to edit, delete, or pin it. Pinned signals (🔒) survive re-research.
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
            {brands.map((b) => (
              <BrandSignals
                key={b.id}
                brand={b}
                isBusy={busy === `brand-${b.id}`}
                anyBusy={busy !== null}
                onResearchSignals={() => researchBrandSignals(b)}
                onResearchSignalsWithFeedback={() =>
                  setFeedbackTarget({ kind: 'brand_signals', id: b.id, name: b.name })
                }
                onSaved={refresh}
              />
            ))}
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
                  onSaved={refresh}
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

// ════════════════════════════════════════════════════════════════════════
// v1.15.0 — BrandSignals: collapsible card mirroring ProductSignals.
// Default collapsed. Click anywhere on the header row to expand.
// ════════════════════════════════════════════════════════════════════════
function BrandSignals({
  brand, isBusy, anyBusy, onResearchSignals, onResearchSignalsWithFeedback, onSaved
}: {
  brand: Brand;
  isBusy: boolean;
  anyBusy: boolean;
  onResearchSignals: () => void;
  onResearchSignalsWithFeedback: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [expanded, setExpanded] = useState(false);
  const bullets = parseSignalsBlob(brand.signals || '');
  const locked = parseLockedSignals(brand.locked_signals);
  const researched = brand.research_status === 'ready';
  const hasSignals = bullets.length > 0;
  const lockedCount = locked.length;

  const saveSignals = async (newBullets: string[], newLocked: string[]) => {
    const signalsText = serializeSignals(newBullets);
    const lockedJson = serializeLockedSignals(newLocked);
    await window.lh.brands.updateSignals(brand.id, signalsText, lockedJson);
    await onSaved();
  };

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, background: researched ? 'white' : '#fafafa' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <button
          onClick={() => setExpanded(!expanded)}
          style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', minWidth: 200 }}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <div style={{ fontWeight: 600, fontSize: 14 }}>{brand.name}</div>
          {!researched ? (
            <span className="chip chip-muted" title="Run brand research from Brands & Products first.">brand not researched yet</span>
          ) : !hasSignals ? (
            <span className="chip chip-muted">no signals yet</span>
          ) : (
            <>
              <span className="chip chip-qualified">{bullets.length} signal{bullets.length === 1 ? '' : 's'}</span>
              {lockedCount > 0 && (
                <span
                  className="chip"
                  style={{ background: '#ede9fe', color: '#5b21b6', fontSize: 11 }}
                  title={`${lockedCount} signal${lockedCount === 1 ? '' : 's'} pinned — re-research will preserve ${lockedCount === 1 ? 'it' : 'them'}.`}
                >
                  🔒 {lockedCount} locked
                </span>
              )}
            </>
          )}
        </button>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="btn-ghost"
            onClick={onResearchSignals}
            disabled={!researched || anyBusy}
            title={researched ? 'Run signal research for this brand (Perplexity sonar-pro, cheap).' : 'Run brand research first from Brands & Products.'}
          >
            {hasSignals ? <RefreshCw size={13} style={{ display: 'inline', marginRight: 4 }} /> : <Sparkles size={13} style={{ display: 'inline', marginRight: 4 }} />}
            {isBusy ? 'Researching…' : (hasSignals ? 'Re-research signals' : 'Research signals')}
          </button>
          <button
            className="btn-ghost"
            onClick={onResearchSignalsWithFeedback}
            disabled={!researched || anyBusy}
            title="Re-research signals while injecting reviewer feedback into the prompt."
          >
            <MessageSquare size={13} style={{ display: 'inline', marginRight: 4 }} />
            Re-research with feedback
          </button>
        </div>
      </div>
      {expanded && researched && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed #e5e7eb' }}>
          <EditableSignalList
            bullets={bullets}
            locked={locked}
            disabled={anyBusy}
            onSave={saveSignals}
            emptyMessage="No signals yet. Click Research signals above to populate, or + Add signal below to add one manually."
          />
        </div>
      )}
    </div>
  );
}

function ProductSignals({
  product, brandName, onToggle,
  onResearchSignals, onResearchSignalsWithFeedback, isBusy, anyBusy,
  embeddingCount, isEmbedding, onEmbedNow, onSaved
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
  onSaved: () => Promise<void> | void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [rules, setRules] = useState<ScanRule[]>([]);
  const bullets = parseSignalsBlob(product.signals || '');
  const locked = parseLockedSignals(product.locked_signals);
  const enabled = product.scan_enabled === 1;
  const hasSignals = bullets.length > 0;
  const lockedCount = locked.length;

  const loadRules = async () => setRules(await window.lh.rules.list(product.id));
  useEffect(() => { if (expanded) loadRules(); }, [expanded]);

  const includes = rules.filter((r) => r.kind === 'include');
  const excludes = rules.filter((r) => r.kind === 'exclude');

  const saveSignals = async (newBullets: string[], newLocked: string[]) => {
    const signalsText = serializeSignals(newBullets);
    const lockedJson = serializeLockedSignals(newLocked);
    await window.lh.products.updateSignals(product.id, signalsText, lockedJson);
    await onSaved();
  };

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
              <span>{hasSignals ? `${bullets.length} signal${bullets.length === 1 ? '' : 's'} ${enabled ? 'tracked' : 'paused'}` : 'no signals yet'}</span>
              {lockedCount > 0 && (
                <span
                  className="chip"
                  style={{ background: '#ede9fe', color: '#5b21b6', fontSize: 11, padding: '1px 6px' }}
                  title={`${lockedCount} signal${lockedCount === 1 ? '' : 's'} pinned — re-research will preserve ${lockedCount === 1 ? 'it' : 'them'}.`}
                >
                  🔒 {lockedCount} locked
                </span>
              )}
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
          <EditableSignalList
            bullets={bullets}
            locked={locked}
            disabled={anyBusy}
            onSave={saveSignals}
            emptyMessage="No signals yet. Click Research signals above to populate, or + Add signal below to add one manually."
          />

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

// ════════════════════════════════════════════════════════════════════════
// v1.15.0 — EditableSignalList: bullets with inline edit / delete / lock
// actions, plus an "+ Add signal" input at the bottom. Used by both
// BrandSignals and ProductSignals.
// ════════════════════════════════════════════════════════════════════════
function EditableSignalList({
  bullets, locked, disabled, onSave, emptyMessage
}: {
  bullets: string[];
  locked: string[];
  disabled?: boolean;
  onSave: (newBullets: string[], newLocked: string[]) => Promise<void>;
  emptyMessage: string;
}) {
  // Local mirror so optimistic updates render immediately.
  const [localBullets, setLocalBullets] = useState<string[]>(bullets);
  const [localLocked, setLocalLocked] = useState<string[]>(locked);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [addText, setAddText] = useState('');
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  // Sync local state when parent updates (e.g. after research finishes).
  useEffect(() => { setLocalBullets(bullets); }, [bullets.join('§§§')]);
  useEffect(() => { setLocalLocked(locked); }, [locked.join('§§§')]);

  const lockedSet = new Set(localLocked);

  const persist = async (nextBullets: string[], nextLocked: string[]) => {
    setLocalBullets(nextBullets);
    setLocalLocked(nextLocked);
    setSaving(true);
    try {
      await onSave(nextBullets, nextLocked);
    } catch (e: any) {
      alert(`Save failed: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (i: number) => {
    if (disabled) return;
    setEditingIdx(i);
    setEditText(localBullets[i]);
  };

  const cancelEdit = () => {
    setEditingIdx(null);
    setEditText('');
  };

  const saveEdit = async () => {
    if (editingIdx === null) return;
    const newText = editText.trim();
    if (!newText) { cancelEdit(); return; }
    const oldText = localBullets[editingIdx];
    if (newText === oldText) { cancelEdit(); return; }
    const nextBullets = localBullets.map((b, j) => (j === editingIdx ? newText : b));
    // v1.15.0 Option A: editing a locked signal keeps it locked (rename in place).
    const nextLocked = renameLockedSignal(localLocked, oldText, newText);
    cancelEdit();
    await persist(nextBullets, nextLocked);
  };

  const deleteBullet = async (i: number) => {
    if (disabled) return;
    const text = localBullets[i];
    const wasLocked = lockedSet.has(text);
    const msg = wasLocked
      ? 'This signal is locked. Delete anyway?'
      : 'Delete this signal?';
    if (!confirm(msg)) return;
    const nextBullets = localBullets.filter((_, j) => j !== i);
    const nextLocked = removeLockedSignal(localLocked, text);
    await persist(nextBullets, nextLocked);
  };

  const toggleLock = async (i: number) => {
    if (disabled) return;
    const text = localBullets[i];
    const currentlyLocked = lockedSet.has(text);
    const nextLocked = currentlyLocked
      ? removeLockedSignal(localLocked, text)
      : [...localLocked, text];
    await persist(localBullets, nextLocked);
  };

  const startAdd = () => {
    if (disabled) return;
    setAdding(true);
    setAddText('');
  };

  const cancelAdd = () => {
    setAdding(false);
    setAddText('');
  };

  const commitAdd = async () => {
    const trimmed = addText.trim();
    if (!trimmed) { cancelAdd(); return; }
    if (localBullets.includes(trimmed)) {
      alert('That signal already exists.');
      return;
    }
    const nextBullets = [...localBullets, trimmed];
    setAddText('');
    // Keep adding mode active so user can chain multiple adds with Enter.
    await persist(nextBullets, localLocked);
  };

  return (
    <div>
      {localBullets.length === 0 && !adding ? (
        <div style={{ color: '#6b7280', fontSize: 13, marginBottom: 10 }}>{emptyMessage}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
          {localBullets.map((bullet, i) => {
            const isLocked = lockedSet.has(bullet);
            const isEditing = editingIdx === i;
            return (
              <div
                key={`${bullet}::${i}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  borderRadius: 6,
                  background: isLocked ? '#f5f3ff' : 'transparent',
                  border: isLocked ? '1px solid #ddd6fe' : '1px solid transparent',
                  transition: 'background 0.1s'
                }}
                onMouseEnter={(e) => {
                  if (!isLocked && !isEditing) (e.currentTarget as HTMLDivElement).style.background = '#fafafa';
                }}
                onMouseLeave={(e) => {
                  if (!isLocked && !isEditing) (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                }}
              >
                {isLocked ? (
                  <Lock size={12} style={{ color: '#6c5cf2', flexShrink: 0 }} />
                ) : (
                  <span style={{ color: '#9ca3af', fontSize: 12, flexShrink: 0, width: 12, textAlign: 'center' }}>•</span>
                )}
                {isEditing ? (
                  <>
                    <input
                      autoFocus
                      className="input"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveEdit();
                        if (e.key === 'Escape') cancelEdit();
                      }}
                      style={{ flex: 1, fontSize: 13 }}
                    />
                    <button
                      onClick={saveEdit}
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2, color: '#065f46' }}
                      title="Save"
                    >
                      <Check size={14} />
                    </button>
                    <button
                      onClick={cancelEdit}
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2, color: '#6b7280' }}
                      title="Cancel"
                    >
                      <X size={14} />
                    </button>
                  </>
                ) : (
                  <>
                    <div style={{ flex: 1, fontSize: 13, color: '#1f2937', lineHeight: 1.5 }}>
                      {bullet}
                    </div>
                    <button
                      onClick={() => toggleLock(i)}
                      disabled={!!disabled || saving}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        cursor: disabled ? 'not-allowed' : 'pointer',
                        padding: 2,
                        color: isLocked ? '#6c5cf2' : '#9ca3af',
                        opacity: isLocked ? 1 : 0.6
                      }}
                      title={isLocked ? 'Unlock — re-research can change this signal' : 'Lock — preserve this signal through re-research'}
                    >
                      {isLocked ? <Lock size={13} /> : <Unlock size={13} />}
                    </button>
                    <button
                      onClick={() => startEdit(i)}
                      disabled={!!disabled || saving}
                      style={{ background: 'transparent', border: 'none', cursor: disabled ? 'not-allowed' : 'pointer', padding: 2, color: '#6b7280' }}
                      title="Edit"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={() => deleteBullet(i)}
                      disabled={!!disabled || saving}
                      style={{ background: 'transparent', border: 'none', cursor: disabled ? 'not-allowed' : 'pointer', padding: 2, color: '#9ca3af' }}
                      title="Delete"
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {adding ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <span style={{ color: '#9ca3af', fontSize: 12, flexShrink: 0, width: 12, textAlign: 'center' }}>+</span>
          <input
            autoFocus
            className="input"
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitAdd();
              if (e.key === 'Escape') cancelAdd();
            }}
            placeholder="Describe a buying signal (e.g. APAC HQ relocation)"
            style={{ flex: 1, fontSize: 13 }}
          />
          <button
            onClick={commitAdd}
            disabled={!addText.trim() || saving}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2, color: '#065f46' }}
            title="Add"
          >
            <Check size={14} />
          </button>
          <button
            onClick={cancelAdd}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2, color: '#6b7280' }}
            title="Done"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <button
          className="btn-ghost"
          onClick={startAdd}
          disabled={!!disabled || saving}
          style={{ fontSize: 12, padding: '4px 10px' }}
        >
          <Plus size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: '-1px' }} />
          Add signal
        </button>
      )}

      <div style={{ marginTop: 10, fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>
        Re-research replaces unlocked signals. Click <Lock size={11} style={{ display: 'inline', verticalAlign: '-1px' }} /> to pin a signal so it survives the next research run.
      </div>
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
