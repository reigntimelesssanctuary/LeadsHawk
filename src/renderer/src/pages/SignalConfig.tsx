import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import type { SignalSource, Product, Brand, ScanRule } from '../../../shared/types';
import {
  Plus, Trash2, Sparkles, ChevronDown, ChevronRight,
  AlertCircle, CheckCircle2, Ban
} from 'lucide-react';

export function SignalConfig() {
  const [products, setProducts] = useState<Product[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [sources, setSources] = useState<SignalSource[]>([]);
  const [rules, setRules] = useState<ScanRule[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const refresh = async () => {
    setProducts(await window.lh.products.list());
    setBrands(await window.lh.brands.list());
    setSources(await window.lh.sources.list());
    setRules(await window.lh.rules.list());
  };
  useEffect(() => { refresh(); }, []);

  const refreshRules = async () => setRules(await window.lh.rules.list());

  const toggleProduct = async (p: Product) => {
    await window.lh.products.setScanEnabled(p.id, p.scan_enabled ? false : true);
    refresh();
  };

  const toggleSource = async (s: SignalSource) => {
    await window.lh.sources.update(s.id, { enabled: s.enabled ? 0 : 1 });
    refresh();
  };

  const productsReady = products.filter((p) => p.research_status === 'ready' && p.signals);
  const productsNotReady = products.filter((p) => !productsReady.includes(p));

  return (
    <div>
      <div style={{ marginTop: 16, marginBottom: 16 }}>
        <div className="h-page">Signal Config</div>
        <div style={{ color: '#6b7280', fontSize: 14, marginTop: 4 }}>
          LeadsHawk scans the web for the buying signals it learned from your product research.
          Toggle individual products on or off below.
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div className="h-section" style={{ marginBottom: 12 }}>
          <Sparkles size={16} style={{ display: 'inline', marginRight: 8, verticalAlign: '-2px', color: '#6c5cf2' }} />
          Auto-derived signals
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
              return (
                <ProductSignals
                  key={p.id}
                  product={p}
                  brandName={brand?.name || ''}
                  onToggle={() => toggleProduct(p)}
                />
              );
            })}
          </div>
        )}

        {productsNotReady.length > 0 && (
          <div style={{ marginTop: 14, fontSize: 13, color: '#6b7280' }}>
            <b>{productsNotReady.length}</b> product{productsNotReady.length === 1 ? '' : 's'} not yet researched —
            run research on {productsNotReady.length === 1 ? 'it' : 'them'} to enable scanning.
          </div>
        )}
      </div>

      <ScanGuidanceCard rules={rules} refresh={refreshRules} />

      <div className="card" style={{ padding: 20 }}>
        <button
          onClick={() => setAdvancedOpen(!advancedOpen)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', width: '100%', textAlign: 'left' }}
        >
          {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <span className="h-section">Advanced — custom topics</span>
          <span style={{ marginLeft: 'auto', color: '#6b7280', fontSize: 13 }}>
            {sources.length} configured
          </span>
        </button>

        {advancedOpen && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
              Optional. Add a free-form topic and LeadsHawk will also search the web for that topic on every scan — in addition to the auto signals above. Useful if you want to hunt for opportunities outside what your product research suggests (e.g. tracking specific competitors or industries).
            </div>

            {sources.length > 0 && (
              <div className="card" style={{ overflow: 'hidden', marginBottom: 12, boxShadow: 'none' }}>
                <table className="lh">
                  <thead>
                    <tr>
                      <th>Topic</th>
                      <th>Query</th>
                      <th>Enabled</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sources.map((s) => {
                      const cfg = (() => { try { return JSON.parse(s.config || '{}'); } catch { return {}; } })();
                      return (
                        <tr key={s.id}>
                          <td style={{ fontWeight: 500 }}>{s.name}</td>
                          <td style={{ color: '#6b7280', maxWidth: 460 }}>{cfg.query || cfg.url || ''}</td>
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
        <AddSourceForm onDone={async () => { setShowAdd(false); refresh(); }} />
      </Modal>
    </div>
  );
}

function ScanGuidanceCard({ rules, refresh }: { rules: ScanRule[]; refresh: () => void }) {
  const includes = rules.filter((r) => r.kind === 'include');
  const excludes = rules.filter((r) => r.kind === 'exclude');
  return (
    <div className="card" style={{ padding: 20, marginBottom: 16 }}>
      <div className="h-section" style={{ marginBottom: 6 }}>
        Scan guidance — include & exclude rules
      </div>
      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>
        These rules apply as <b>hard constraints</b> on every scan. Use them to focus the scanner
        (e.g. <i>only enterprise customers in North America</i>) or filter results out
        (e.g. <i>exclude startups under $10M revenue</i>).
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <RuleColumn
          kind="include"
          icon={<CheckCircle2 size={16} style={{ color: '#065f46' }} />}
          title="Always include"
          accent="#065f46"
          accentBg="#ecfdf5"
          accentBorder="#a7f3d0"
          placeholder="e.g. publicly traded companies only"
          rules={includes}
          refresh={refresh}
        />
        <RuleColumn
          kind="exclude"
          icon={<Ban size={16} style={{ color: '#991b1b' }} />}
          title="Always exclude"
          accent="#991b1b"
          accentBg="#fef2f2"
          accentBorder="#fecaca"
          placeholder="e.g. consulting firms"
          rules={excludes}
          refresh={refresh}
        />
      </div>
    </div>
  );
}

function RuleColumn({
  kind, icon, title, accent, accentBg, accentBorder, placeholder, rules, refresh
}: {
  kind: 'include' | 'exclude';
  icon: React.ReactNode;
  title: string;
  accent: string;
  accentBg: string;
  accentBorder: string;
  placeholder: string;
  rules: ScanRule[];
  refresh: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await window.lh.rules.create({ kind, text: trimmed });
      setText('');
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, color: accent, fontWeight: 600, fontSize: 14 }}>
        {icon} {title}
        <span style={{ marginLeft: 'auto', color: '#6b7280', fontWeight: 400, fontSize: 12 }}>
          {rules.length} rule{rules.length === 1 ? '' : 's'}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
        {rules.length === 0 && (
          <div style={{ color: '#9ca3af', fontSize: 13, fontStyle: 'italic', padding: '4px 0' }}>
            No rules yet.
          </div>
        )}
        {rules.map((r) => (
          <div
            key={r.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 10px',
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
            <div style={{ flex: 1, fontSize: 13, color: '#1f2937', lineHeight: 1.45 }}>{r.text}</div>
            <button
              onClick={async () => {
                if (confirm('Delete this rule?')) {
                  await window.lh.rules.delete(r.id);
                  refresh();
                }
              }}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 4 }}
              title="Delete"
            >
              <Trash2 size={14} />
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
          style={{ flex: 1 }}
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

function ProductSignals({
  product, brandName, onToggle
}: { product: Product; brandName: string; onToggle: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const signalLines = parseBullets(product.signals || '');
  const enabled = product.scan_enabled === 1;

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, background: enabled ? 'white' : '#fafafa' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
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
          style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              {product.name}
              <span style={{ color: '#6b7280', fontWeight: 400 }}> · {brandName}</span>
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
              {signalLines.length} signal{signalLines.length === 1 ? '' : 's'} {enabled ? 'tracked' : 'paused'}
            </div>
          </div>
        </button>
      </div>
      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed #e5e7eb' }}>
          {signalLines.length === 0 ? (
            <div style={{ color: '#6b7280', fontSize: 13 }}>No signals captured. Try re-running research.</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#1f2937', lineHeight: 1.6 }}>
              {signalLines.map((line, i) => (
                <li key={i} style={{ marginBottom: 4 }}>{line}</li>
              ))}
            </ul>
          )}
          <div style={{ marginTop: 10, fontSize: 12, color: '#6b7280' }}>
            To edit these signals, go to <b>Brands & Products</b> → re-run research, or update the product's research dossier directly.
          </div>
        </div>
      )}
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

function AddSourceForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  return (
    <div>
      <label className="label">Topic name</label>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Healthcare data breaches" />
      <div style={{ height: 12 }} />
      <label className="label">Search query</label>
      <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. healthcare ransomware OR patient data breach" />
      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>
        LeadsHawk will search the web for this topic on every scan, in addition to the auto-derived signals from your products.
      </div>
      <div style={{ marginTop: 14, textAlign: 'right' }}>
        <button className="btn-primary" disabled={!name || !query} onClick={async () => {
          await window.lh.sources.create({
            name,
            kind: 'query',
            config: JSON.stringify({ query }),
            enabled: 1
          });
          onDone();
        }}>Save topic</button>
      </div>
    </div>
  );
}
