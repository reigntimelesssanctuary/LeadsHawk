import { useEffect, useState } from 'react';
import type { Brand, Product, KnowledgeItem } from '../../../shared/types';
import { Modal } from '../components/Modal';
import { Plus, FileText, Link2, NotebookPen, Sparkles, Trash2, RefreshCw } from 'lucide-react';
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

function BrandPanel({ brand, onChanged }: { brand: Brand; onChanged: () => void }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]);
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [showAddNote, setShowAddNote] = useState(false);
  const [showAddLink, setShowAddLink] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    setProducts(await window.lh.products.list(brand.id));
    setKnowledge(await window.lh.knowledge.list(brand.id));
  };
  useEffect(() => { refresh(); }, [brand.id]);

  const upload = async () => {
    setBusy('upload');
    try { await window.lh.knowledge.upload(brand.id); await refresh(); }
    finally { setBusy(null); }
  };

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
          <button className="btn-danger" onClick={deleteBrand}>Delete</button>
        </div>
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
            <div key={p.id} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{p.name}{p.category ? <span style={{ color: '#6b7280', fontWeight: 400 }}> — {p.category}</span> : null}</div>
                  <div style={{ color: '#6b7280', fontSize: 13, marginTop: 4 }}>{p.description || 'No description.'}</div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
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
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div className="h-section">Knowledge Base</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn-ghost" onClick={upload} disabled={busy === 'upload'}>
              <FileText size={14} style={{ display: 'inline', marginRight: 4 }} />
              {busy === 'upload' ? 'Uploading…' : 'Upload Files'}
            </button>
            <button className="btn-ghost" onClick={() => setShowAddLink(true)}>
              <Link2 size={14} style={{ display: 'inline', marginRight: 4 }} /> Add Link
            </button>
            <button className="btn-ghost" onClick={() => setShowAddNote(true)}>
              <NotebookPen size={14} style={{ display: 'inline', marginRight: 4 }} /> Add Note
            </button>
          </div>
        </div>
        {knowledge.length === 0 && <div style={{ color: '#6b7280', fontSize: 13 }}>No knowledge ingested. Upload PDFs/PPTs, link sources, or paste notes.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {knowledge.map((k) => (
            <div key={k.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500, fontSize: 14 }}>
                  {k.kind === 'link' ? (
                    <a onClick={() => openExternal(k.source)} style={{ cursor: 'pointer' }}>{k.title}</a>
                  ) : k.title}
                </div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>
                  <span className="chip chip-muted" style={{ marginRight: 6 }}>{k.kind}</span>
                  {fmtDateShort(k.created_at)} {k.kind === 'link' && '· ' + k.source}
                </div>
              </div>
              <button className="btn-danger" onClick={async () => { if (confirm('Remove this item?')) { await window.lh.knowledge.delete(k.id); refresh(); } }}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <Modal open={showAddProduct} onClose={() => setShowAddProduct(false)} title="Add Product">
        <AddProductForm brandId={brand.id} onDone={async () => { setShowAddProduct(false); await refresh(); }} />
      </Modal>
      <Modal open={showAddNote} onClose={() => setShowAddNote(false)} title="Add Knowledge Note">
        <AddNoteForm brandId={brand.id} onDone={async () => { setShowAddNote(false); await refresh(); }} />
      </Modal>
      <Modal open={showAddLink} onClose={() => setShowAddLink(false)} title="Add Knowledge Link">
        <AddLinkForm brandId={brand.id} onDone={async () => { setShowAddLink(false); await refresh(); }} />
      </Modal>
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

function AddNoteForm({ brandId, onDone }: { brandId: number; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  return (
    <div>
      <label className="label">Title</label>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      <div style={{ height: 12 }} />
      <label className="label">Content</label>
      <textarea className="textarea" value={content} onChange={(e) => setContent(e.target.value)} style={{ minHeight: 200 }} />
      <div style={{ marginTop: 14, textAlign: 'right' }}>
        <button className="btn-primary" disabled={!title || !content} onClick={async () => {
          await window.lh.knowledge.addNote({ brandId, title, content });
          onDone();
        }}>Save Note</button>
      </div>
    </div>
  );
}

function AddLinkForm({ brandId, onDone }: { brandId: number; onDone: () => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <label className="label">URL</label>
      <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>LeadsHawk will fetch the page and add it to the knowledge base.</div>
      {error && <div style={{ color: '#b91c1c', marginTop: 8, fontSize: 13 }}>{error}</div>}
      <div style={{ marginTop: 14, textAlign: 'right' }}>
        <button className="btn-primary" disabled={!url || busy} onClick={async () => {
          setBusy(true); setError(null);
          try {
            await window.lh.knowledge.addLink({ brandId, url });
            onDone();
          } catch (e: any) { setError(e.message); }
          finally { setBusy(false); }
        }}>{busy ? 'Fetching…' : 'Add Link'}</button>
      </div>
    </div>
  );
}
