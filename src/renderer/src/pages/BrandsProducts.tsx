import { useEffect, useState } from 'react';
import type { Brand, Product, KnowledgeItem } from '../../../shared/types';
import { Modal } from '../components/Modal';
import { Switch } from '../components/Switch';
import { Plus, FileText, Link2, NotebookPen, Sparkles, Trash2 } from 'lucide-react';
import { openExternal, fmtDateShort } from '../lib/api';

export function BrandsProducts() {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [active, setActive] = useState<Brand | null>(null);
  const [showAddBrand, setShowAddBrand] = useState(false);

  const refresh = async () => {
    const list = await window.lh.brands.list();
    setBrands(list);
    if (list.length && !active) setActive(list[0]);
    else if (active) {
      const cur = list.find((b) => b.id === active.id);
      setActive(cur || list[0] || null);
    }
  };
  useEffect(() => { refresh(); }, []);

  return (
    <div>
      <div style={{ marginTop: 16, marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <div className="h-page">Brands & Products</div>
          <div style={{ color: '#6b7280', fontSize: 14, marginTop: 4 }}>
            Curate the portfolio LeadsHawk hunts opportunities for
          </div>
        </div>
        <button className="btn-primary" onClick={() => setShowAddBrand(true)}>
          <Plus size={14} style={{ display: 'inline', marginRight: 6 }} /> Add Brand
        </button>
      </div>

      <div style={{ display: 'flex', gap: 20 }}>
        <div style={{ width: 240 }} className="card">
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #e5e7eb', fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Brands</div>
          {brands.length === 0 && <div style={{ padding: 16, color: '#6b7280', fontSize: 13 }}>No brands yet. Add one to get started.</div>}
          {brands.map((b) => (
            <button
              key={b.id}
              onClick={() => setActive(b)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '12px 16px', border: 'none', cursor: 'pointer',
                background: active?.id === b.id ? '#f3f4ff' : 'white',
                fontWeight: 500, fontSize: 14
              }}
            >
              {b.name}
            </button>
          ))}
        </div>

        {active ? (
          <div style={{ flex: 1 }}>
            <BrandPanel brand={active} onChanged={refresh} />
          </div>
        ) : (
          <div className="card" style={{ flex: 1, padding: 24, color: '#6b7280' }}>
            Add a brand to begin.
          </div>
        )}
      </div>

      <Modal open={showAddBrand} onClose={() => setShowAddBrand(false)} title="Add Brand">
        <AddBrandForm
          onDone={async (b) => {
            setShowAddBrand(false);
            await refresh();
            setActive(b);
          }}
        />
      </Modal>
    </div>
  );
}

function AddBrandForm({ onDone }: { onDone: (b: Brand) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  return (
    <div>
      <label className="label">Name</label>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Juniper Networks" />
      <div style={{ height: 12 }} />
      <label className="label">Short description</label>
      <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this brand sells, who it sells to" />
      <div style={{ marginTop: 14, textAlign: 'right' }}>
        <button className="btn-primary" disabled={!name || submitting} onClick={async () => {
          setSubmitting(true);
          const b = await window.lh.brands.create({ name, description });
          onDone(b as Brand);
          setSubmitting(false);
        }}>Save Brand</button>
      </div>
    </div>
  );
}

// noteTarget / linkTarget convention:
//   false      → modal closed
//   null       → modal open at brand-level
//   <number>   → modal open at product-level (this product id)
type ModalTarget = false | null | number;

function BrandPanel({ brand, onChanged }: { brand: Brand; onChanged: () => void }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]);
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [noteTarget, setNoteTarget] = useState<ModalTarget>(false);
  const [linkTarget, setLinkTarget] = useState<ModalTarget>(false);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    setProducts(await window.lh.products.list(brand.id));
    setKnowledge(await window.lh.knowledge.list(brand.id));
  };
  useEffect(() => { refresh(); }, [brand.id]);

  const upload = async (productId: number | null) => {
    const key = productId === null ? 'upload' : `upload-${productId}`;
    setBusy(key);
    try { await window.lh.knowledge.upload(brand.id, productId); await refresh(); }
    finally { setBusy(null); }
  };

  const brandKnowledge = knowledge.filter((k) => !k.product_id);
  const knowledgeForProduct = (productId: number) =>
    knowledge.filter((k) => k.product_id === productId);
  const noteProductId = typeof noteTarget === 'number' ? noteTarget : null;
  const linkProductId = typeof linkTarget === 'number' ? linkTarget : null;
  const noteProduct = noteProductId ? products.find((p) => p.id === noteProductId) : null;
  const linkProduct = linkProductId ? products.find((p) => p.id === linkProductId) : null;

  const research = async (productId: number) => {
    setBusy('research-' + productId);
    try { await window.lh.products.research(productId); await refresh(); onChanged(); }
    catch (e: any) { alert(e.message); }
    finally { setBusy(null); }
  };

  const deleteBrand = async () => {
    if (!confirm(`Delete brand "${brand.name}" and all its products & knowledge?`)) return;
    await window.lh.brands.delete(brand.id);
    onChanged();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="h-section">{brand.name}</div>
            <div style={{ color: '#6b7280', fontSize: 13, marginTop: 4 }}>{brand.description || 'No description yet.'}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <Switch
              checked={brand.scan_enabled === 1}
              label="Include in scans"
              onChange={async (v) => { await window.lh.brands.setScanEnabled(brand.id, v); onChanged(); }}
            />
            <button className="btn-danger" onClick={deleteBrand}>Delete</button>
          </div>
        </div>
        {brand.scan_enabled !== 1 && (
          <div style={{ marginTop: 14, padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 13, color: '#991b1b' }}>
            This brand is excluded from job scans — none of its products will be scanned, regardless of their individual toggles.
          </div>
        )}
        {brand.competitive_summary && (
          <div style={{ marginTop: 16, padding: 14, background: '#f3f4ff', borderRadius: 8, fontSize: 13, color: '#1f2937' }}>
            <div className="label" style={{ marginBottom: 6 }}>Competitive Summary</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{brand.competitive_summary}</div>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div className="h-section">Products</div>
          <button className="btn-ghost" onClick={() => setShowAddProduct(true)}>
            <Plus size={14} style={{ display: 'inline', marginRight: 4 }} /> Add Product
          </button>
        </div>
        {products.length === 0 && <div style={{ color: '#6b7280', fontSize: 13 }}>No products yet.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {products.map((p) => (
            <div key={p.id} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, background: p.scan_enabled === 1 ? 'white' : '#fafafa' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{p.name}{p.category ? <span style={{ color: '#6b7280', fontWeight: 400 }}> — {p.category}</span> : null}</div>
                  <div style={{ color: '#6b7280', fontSize: 13, marginTop: 4 }}>{p.description || 'No description.'}</div>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <Switch
                    checked={p.scan_enabled === 1 && brand.scan_enabled === 1}
                    disabled={brand.scan_enabled !== 1}
                    label="Scan"
                    onChange={async (v) => { await window.lh.products.setScanEnabled(p.id, v); refresh(); }}
                  />
                  <button className="btn-ghost" onClick={() => research(p.id)} disabled={busy === 'research-' + p.id}>
                    <Sparkles size={13} style={{ display: 'inline', marginRight: 4 }} />
                    {busy === 'research-' + p.id ? 'Researching…' : (p.research_status === 'ready' ? 'Re-research' : 'Run research')}
                  </button>
                  <button className="btn-danger" onClick={async () => {
                    if (confirm(`Delete ${p.name}?`)) { await window.lh.products.delete(p.id); refresh(); }
                  }}><Trash2 size={13} /></button>
                </div>
              </div>
              {p.research_summary && (
                <details style={{ marginTop: 10 }}>
                  <summary style={{ cursor: 'pointer', color: '#6b7280', fontSize: 12 }}>View research dossier</summary>
                  <div style={{ marginTop: 8, fontSize: 13, display: 'grid', gap: 10 }}>
                    {p.use_cases && <Field label="Use cases" value={p.use_cases} />}
                    {p.competitors && <Field label="Competitors" value={p.competitors} />}
                    {p.differentiators && <Field label="Differentiators" value={p.differentiators} />}
                    {p.signals && <Field label="Signals to watch" value={p.signals} />}
                    <Field label="Summary" value={p.research_summary} />
                  </div>
                </details>
              )}

              {/* Product-level knowledge */}
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed #e5e7eb' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div className="label">Product knowledge</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn-ghost" onClick={() => upload(p.id)} disabled={busy === `upload-${p.id}`}>
                      <FileText size={13} style={{ display: 'inline', marginRight: 4 }} />
                      {busy === `upload-${p.id}` ? 'Uploading…' : 'Upload'}
                    </button>
                    <button className="btn-ghost" onClick={() => setLinkTarget(p.id)}>
                      <Link2 size={13} style={{ display: 'inline', marginRight: 4 }} /> Add Link
                    </button>
                    <button className="btn-ghost" onClick={() => setNoteTarget(p.id)}>
                      <NotebookPen size={13} style={{ display: 'inline', marginRight: 4 }} /> Add Note
                    </button>
                  </div>
                </div>
                {knowledgeForProduct(p.id).length === 0 ? (
                  <div style={{ color: '#9ca3af', fontSize: 12, fontStyle: 'italic' }}>
                    Nothing attached yet — uploads / links / notes added here will be prioritised when running research for this product.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {knowledgeForProduct(p.id).map((k) => (
                      <KnowledgeRow key={k.id} item={k} onDelete={async () => {
                        if (confirm('Remove this item?')) { await window.lh.knowledge.delete(k.id); refresh(); }
                      }} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div className="h-section">Brand-level Knowledge</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn-ghost" onClick={() => upload(null)} disabled={busy === 'upload'}>
              <FileText size={14} style={{ display: 'inline', marginRight: 4 }} />
              {busy === 'upload' ? 'Uploading…' : 'Upload Files'}
            </button>
            <button className="btn-ghost" onClick={() => setLinkTarget(null)}>
              <Link2 size={14} style={{ display: 'inline', marginRight: 4 }} /> Add Link
            </button>
            <button className="btn-ghost" onClick={() => setNoteTarget(null)}>
              <NotebookPen size={14} style={{ display: 'inline', marginRight: 4 }} /> Add Note
            </button>
          </div>
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          Material that applies to the whole brand. For product-specific material, use the “Product knowledge” section inside each product above.
        </div>
        {brandKnowledge.length === 0 ? (
          <div style={{ color: '#6b7280', fontSize: 13 }}>Nothing at brand level. Upload PDFs/PPTs, link sources, or paste notes.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {brandKnowledge.map((k) => (
              <KnowledgeRow key={k.id} item={k} onDelete={async () => {
                if (confirm('Remove this item?')) { await window.lh.knowledge.delete(k.id); refresh(); }
              }} />
            ))}
          </div>
        )}
      </div>

      <Modal open={showAddProduct} onClose={() => setShowAddProduct(false)} title="Add Product">
        <AddProductForm brandId={brand.id} onDone={async () => { setShowAddProduct(false); await refresh(); }} />
      </Modal>
      <Modal
        open={noteTarget !== false}
        onClose={() => setNoteTarget(false)}
        title={noteProduct ? `Add Note — ${noteProduct.name}` : 'Add Brand-level Note'}
      >
        <AddNoteForm
          brandId={brand.id}
          productId={noteProductId}
          productName={noteProduct?.name}
          onDone={async () => { setNoteTarget(false); await refresh(); }}
        />
      </Modal>
      <Modal
        open={linkTarget !== false}
        onClose={() => setLinkTarget(false)}
        title={linkProduct ? `Add Link — ${linkProduct.name}` : 'Add Brand-level Link'}
      >
        <AddLinkForm
          brandId={brand.id}
          productId={linkProductId}
          productName={linkProduct?.name}
          onDone={async () => { setLinkTarget(false); await refresh(); }}
        />
      </Modal>
    </div>
  );
}

function KnowledgeRow({ item, onDelete }: { item: KnowledgeItem; onDelete: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, fontSize: 14 }}>
          {item.kind === 'link' ? (
            <a onClick={() => openExternal(item.source)} style={{ cursor: 'pointer' }}>{item.title}</a>
          ) : item.title}
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          <span className="chip chip-muted" style={{ marginRight: 6 }}>{item.kind}</span>
          {fmtDateShort(item.created_at)} {item.kind === 'link' && '· ' + item.source}
        </div>
      </div>
      <button className="btn-danger" onClick={onDelete}>
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ whiteSpace: 'pre-wrap', color: '#1f2937', fontSize: 13 }}>{value}</div>
    </div>
  );
}

function AddProductForm({ brandId, onDone }: { brandId: number; onDone: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  return (
    <div>
      <label className="label">Product name</label>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      <div style={{ height: 12 }} />
      <label className="label">Category</label>
      <input className="input" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. SD-WAN, firewall, observability" />
      <div style={{ height: 12 }} />
      <label className="label">Short description</label>
      <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} />
      <div style={{ marginTop: 14, textAlign: 'right' }}>
        <button className="btn-primary" disabled={!name} onClick={async () => {
          await window.lh.products.create({ brand_id: brandId, name, description, category });
          onDone();
        }}>Save Product</button>
      </div>
    </div>
  );
}

function AddNoteForm({
  brandId, productId, productName, onDone
}: { brandId: number; productId: number | null; productName?: string; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  return (
    <div>
      {productName && (
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
          Attaching to product <b>{productName}</b>. This note will be prioritised when running research for it.
        </div>
      )}
      <label className="label">Title</label>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      <div style={{ height: 12 }} />
      <label className="label">Content</label>
      <textarea className="textarea" value={content} onChange={(e) => setContent(e.target.value)} style={{ minHeight: 200 }} />
      <div style={{ marginTop: 14, textAlign: 'right' }}>
        <button className="btn-primary" disabled={!title || !content} onClick={async () => {
          await window.lh.knowledge.addNote({ brandId, productId, title, content });
          onDone();
        }}>Save Note</button>
      </div>
    </div>
  );
}

function AddLinkForm({
  brandId, productId, productName, onDone
}: { brandId: number; productId: number | null; productName?: string; onDone: () => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      {productName && (
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
          Attaching to product <b>{productName}</b>.
        </div>
      )}
      <label className="label">URL</label>
      <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>LeadsHawk will fetch the page and add it to the knowledge base.</div>
      {error && <div style={{ color: '#b91c1c', marginTop: 8, fontSize: 13 }}>{error}</div>}
      <div style={{ marginTop: 14, textAlign: 'right' }}>
        <button className="btn-primary" disabled={!url || busy} onClick={async () => {
          setBusy(true); setError(null);
          try {
            await window.lh.knowledge.addLink({ brandId, productId, url });
            onDone();
          } catch (e: any) { setError(e.message); }
          finally { setBusy(false); }
        }}>{busy ? 'Fetching…' : 'Add Link'}</button>
      </div>
    </div>
  );
}
