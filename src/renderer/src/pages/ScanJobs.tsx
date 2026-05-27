import { useEffect, useState } from 'react';
import type { ScanRun, Brand, Product } from '../../../shared/types';
import { fmtDate } from '../lib/api';
import { Switch } from '../components/Switch';

export function ScanJobs() {
  const [runs, setRuns] = useState<ScanRun[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [running, setRunning] = useState(false);
  const [selectedRun, setSelectedRun] = useState<ScanRun | null>(null);

  const refresh = async () => {
    const [r, b, p] = await Promise.all([
      window.lh.scan.runs(),
      window.lh.brands.list(),
      window.lh.products.list()
    ]);
    setRuns(r);
    setBrands(b);
    setProducts(p);
  };
  useEffect(() => { refresh(); }, []);

  return (
    <div>
      <div style={{ marginTop: 16, marginBottom: 16 }}>
        <div className="h-page">Scan Jobs</div>
        <div style={{ color: '#6b7280', fontSize: 14, marginTop: 4 }}>
          Scan inclusion + run history. Schedule and toggles live under <b>Settings → Scan</b>.
        </div>
      </div>

      <ScanInclusionCard brands={brands} products={products} onChanged={refresh} />

      <div className="card" style={{ padding: 20, marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div className="h-card">Manual run</div>
          <div style={{ color: '#6b7280', fontSize: 13, marginTop: 4 }}>
            Runs the two-stage scan: Perplexity sonar-deep-research discovery → Claude qualification. Slower and costlier than the retired manual scan, but produces better leads.
          </div>
        </div>
        <button
          className="btn-primary"
          onClick={async () => {
            setRunning(true);
            try { await window.lh.scan.runDeep(); refresh(); }
            catch (e: any) { alert(e.message); }
            finally { setRunning(false); }
          }}
          disabled={running}
        >
          {running ? 'Scanning…' : 'Run Scan Now'}
        </button>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb' }}>
          <div className="h-card">History</div>
        </div>
        <table className="lh">
          <thead>
            <tr>
              <th>Started</th>
              <th>Finished</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Scanned</th>
              <th>Opportunities</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', color: '#6b7280', padding: 28 }}>No runs yet.</td></tr>}
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{fmtDate(r.started_at)}</td>
                <td>{fmtDate(r.finished_at)}</td>
                <td>
                  <span className={`chip ${r.kind === 'deep' ? 'chip-brand' : 'chip-muted'}`}>
                    {r.kind === 'deep' ? 'scan' : 'manual (legacy)'}
                  </span>
                </td>
                <td><span className={`chip ${r.status === 'completed' ? 'chip-qualified' : r.status === 'error' ? 'chip-disqualified' : 'chip-open'}`}>{r.status}</span></td>
                <td>{r.items_scanned}</td>
                <td>{r.opportunities_created}</td>
                <td><button className="btn-ghost" onClick={() => setSelectedRun(r)}>Logs</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedRun && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, padding: 40 }}
          onClick={() => setSelectedRun(null)}
        >
          <div className="card" style={{ height: '100%', padding: 24, overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <div className="h-section" style={{ marginBottom: 12 }}>Run #{selectedRun.id} logs</div>
            <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', background: '#0b0d12', color: '#d1d5db', padding: 16, borderRadius: 8 }}>{selectedRun.log || '(no logs)'}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function resolveRecencyForRow(brand: Brand, product?: Product): { value: string; source: string } | null {
  if (product?.scan_recency_override) return { value: product.scan_recency_override, source: 'product override' };
  if (product?.scan_recency_auto)     return { value: product.scan_recency_auto,     source: 'product auto' };
  if (brand.scan_recency_override)    return { value: brand.scan_recency_override,   source: 'brand override' };
  if (brand.scan_recency_auto)        return { value: brand.scan_recency_auto,       source: 'brand auto' };
  return null;
}
function shortRecency(r: string): string {
  switch (r) { case 'day': return '24h'; case 'week': return '7d'; case 'month': return '30d'; case 'year': return '12mo'; default: return r; }
}
function RecencyCell({ brand, product }: { brand: Brand; product?: Product }) {
  const r = resolveRecencyForRow(brand, product);
  if (!r) return <span style={{ fontSize: 12, color: '#9ca3af' }} title="No per-brand or per-product recency set — scans use Settings → Recency window">global</span>;
  const isOverride = r.source.includes('override');
  return (
    <span
      style={{
        fontSize: 12, fontWeight: 500,
        color: isOverride ? '#5b21b6' : '#065f46',
        background: isOverride ? '#ede9fe' : '#d1fae5',
        padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap'
      }}
      title={`Window: ${r.value} — source: ${r.source}. Change via the brand or product Edit modal on Brands & Products.`}
    >
      {shortRecency(r.value)} ({isOverride ? 'override' : 'auto'})
    </span>
  );
}

function ScanInclusionCard({
  brands, products, onChanged
}: {
  brands: Brand[];
  products: Product[];
  onChanged: () => void;
}) {
  const enabledBrandCount = brands.filter((b) => b.scan_enabled === 1).length;
  const enabledProductCount = products.filter(
    (p) => p.scan_enabled === 1 && brands.find((b) => b.id === p.brand_id)?.scan_enabled === 1
  ).length;

  return (
    <div className="card" style={{ padding: 20, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div className="h-card">Scan inclusion</div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          {enabledBrandCount}/{brands.length} brand{brands.length === 1 ? '' : 's'} ·{' '}
          {enabledProductCount}/{products.length} product{products.length === 1 ? '' : 's'} active
        </div>
      </div>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>
        Toggle what gets included in scans and the live monitor. Disabling a brand pauses all of its products regardless of the per-product toggle.
      </div>
      {brands.length === 0 ? (
        <div style={{ color: '#6b7280', fontSize: 13 }}>
          No brands yet. Add some on the <b>Brands &amp; Products</b> tab.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {brands.map((b) => {
            const brandProducts = products.filter((p) => p.brand_id === b.id);
            const brandOn = b.scan_enabled === 1;
            return (
              <div key={b.id} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, background: brandOn ? 'white' : '#fafafa' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span>{b.name}</span>
                      <RecencyCell brand={b} />
                    </div>
                    {b.description && (
                      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                        {b.description.slice(0, 120)}{b.description.length > 120 ? '…' : ''}
                      </div>
                    )}
                  </div>
                  <Switch
                    checked={brandOn}
                    label="Include in scans"
                    onChange={async (v) => { await window.lh.brands.setScanEnabled(b.id, v); onChanged(); }}
                  />
                </div>
                {brandProducts.length > 0 && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed #e5e7eb', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {brandProducts.map((p) => (
                      <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 6, gap: 10 }}>
                        <div style={{ fontSize: 13, color: brandOn ? '#1f2937' : '#9ca3af', display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                          <span>{p.name}</span>
                          {p.research_status !== 'ready' && (
                            <span style={{ fontSize: 11, color: '#92400e' }}>(not researched)</span>
                          )}
                          <RecencyCell brand={b} product={p} />
                        </div>
                        <Switch
                          checked={p.scan_enabled === 1 && brandOn}
                          disabled={!brandOn}
                          label="Scan"
                          onChange={async (v) => { await window.lh.products.setScanEnabled(p.id, v); onChanged(); }}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {brandProducts.length === 0 && (
                  <div style={{ marginTop: 8, fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>
                    No products under this brand.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// v1.12.0: ScheduleEditor removed — manual scan retired. Deep scan
// schedule lives in Settings → Scan card. Settings import also dropped.
