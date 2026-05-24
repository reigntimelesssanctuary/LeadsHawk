import { useEffect, useMemo, useState } from 'react';
import { StatCard } from '../components/StatCard';
import type { DashboardStats, Opportunity, Brand, Product } from '../../../shared/types';
import { fmtDate, fmtDateShort, openExternal } from '../lib/api';
import { Trash2, Download, ArrowUp, ArrowDown } from 'lucide-react';

type ScanType = 'Manual Scan' | 'Live Monitor';

function scanTypeOf(opp: Opportunity): ScanType {
  // Live monitor stamps raw_signal.source = 'live_monitor' and source_title = 'live monitor'.
  // Cron scanner stamps source like 'auto:<product>' or 'custom:<topic>'.
  if (opp.source_title?.toLowerCase().includes('live monitor')) return 'Live Monitor';
  try {
    const raw = opp.raw_signal ? JSON.parse(opp.raw_signal) : null;
    const src = String(raw?.source || '').toLowerCase();
    if (src.startsWith('live_monitor') || src === 'live monitor') return 'Live Monitor';
  } catch { /* fall through */ }
  return 'Manual Scan';
}

type SortKey = 'date' | 'company' | 'industry' | 'brand' | 'product' | 'scanType' | 'confidence' | 'signal';
type SortDir = 'asc' | 'desc';

type Filters = {
  company: string;
  industry: string;
  brand: string;     // exact match by name; '' = all
  product: string;
  scanType: '' | ScanType;
  confidenceMin: string; // numeric string 0-100; '' = all
  signal: string;
};

const EMPTY_FILTERS: Filters = {
  company: '',
  industry: '',
  brand: '',
  product: '',
  scanType: '',
  confidenceMin: '',
  signal: ''
};

type Row = {
  opp: Opportunity;
  scanType: ScanType;
  brandName: string;
  productName: string;
};

export function Dashboard({ onOpenOpp }: { onOpenOpp: (id: number) => void }) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [exporting, setExporting] = useState(false);
  const [exportToast, setExportToast] = useState<string | null>(null);

  const refresh = async () => {
    const [s, list, bs, ps] = await Promise.all([
      window.lh.dashboard.stats(),
      window.lh.opps.list('open'),
      window.lh.brands.list(),
      window.lh.products.list()
    ]);
    setStats(s);
    setOpps(list);
    setBrands(bs);
    setProducts(ps);
    setSelected((prev) => {
      const liveIds = new Set(list.map((o: Opportunity) => o.id));
      const next = new Set<number>();
      for (const id of prev) if (liveIds.has(id)) next.add(id);
      return next;
    });
  };

  useEffect(() => { refresh(); }, []);

  const runScan = async () => {
    setRunning(true); setError(null);
    try {
      await window.lh.scan.run();
      await refresh();
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setRunning(false);
    }
  };

  // Resolve names sync via maps for fast filtering
  const brandMap = useMemo(() => new Map(brands.map((b) => [b.id, b.name])), [brands]);
  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p.name])), [products]);

  const allRows: Row[] = useMemo(
    () =>
      opps.map((o) => ({
        opp: o,
        scanType: scanTypeOf(o),
        brandName: o.brand_id ? brandMap.get(o.brand_id) || '—' : '—',
        productName: o.product_id ? productMap.get(o.product_id) || '—' : '—'
      })),
    [opps, brandMap, productMap]
  );

  const filteredRows = useMemo(() => {
    const minConf = Number(filters.confidenceMin);
    const minConfSet = !Number.isNaN(minConf) && filters.confidenceMin !== '';
    return allRows.filter((r) => {
      if (filters.company && !r.opp.company.toLowerCase().includes(filters.company.toLowerCase())) return false;
      if (filters.industry && !(r.opp.industry || '').toLowerCase().includes(filters.industry.toLowerCase())) return false;
      if (filters.brand && r.brandName !== filters.brand) return false;
      if (filters.product && r.productName !== filters.product) return false;
      if (filters.scanType && r.scanType !== filters.scanType) return false;
      if (minConfSet && Math.round((r.opp.confidence || 0) * 100) < minConf) return false;
      if (filters.signal && !(r.opp.signal_summary || '').toLowerCase().includes(filters.signal.toLowerCase())) return false;
      return true;
    });
  }, [allRows, filters]);

  const sortedRows = useMemo(() => {
    const arr = [...filteredRows];
    const dir = sortDir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      switch (sortKey) {
        case 'date': {
          const ax = a.opp.created_at || '';
          const bx = b.opp.created_at || '';
          if (ax < bx) return -1 * dir;
          if (ax > bx) return 1 * dir;
          return (a.opp.id - b.opp.id) * dir;
        }
        case 'company':    return a.opp.company.localeCompare(b.opp.company) * dir;
        case 'industry':   return (a.opp.industry || '').localeCompare(b.opp.industry || '') * dir;
        case 'brand':      return a.brandName.localeCompare(b.brandName) * dir;
        case 'product':    return a.productName.localeCompare(b.productName) * dir;
        case 'scanType':   return a.scanType.localeCompare(b.scanType) * dir;
        case 'confidence': return ((a.opp.confidence || 0) - (b.opp.confidence || 0)) * dir;
        case 'signal':     return (a.opp.signal_summary || '').localeCompare(b.opp.signal_summary || '') * dir;
      }
    });
    return arr;
  }, [filteredRows, sortKey, sortDir]);

  // Dropdown option values
  const brandOptions = useMemo(
    () => Array.from(new Set(allRows.map((r) => r.brandName).filter((n) => n && n !== '—'))).sort(),
    [allRows]
  );
  const productOptions = useMemo(
    () => Array.from(new Set(allRows.map((r) => r.productName).filter((n) => n && n !== '—'))).sort(),
    [allRows]
  );

  const allVisibleSelected = sortedRows.length > 0 && sortedRows.every((r) => selected.has(r.opp.id));
  const someVisibleSelected = sortedRows.some((r) => selected.has(r.opp.id)) && !allVisibleSelected;
  const toggleAllVisible = () => {
    if (allVisibleSelected) {
      const next = new Set(selected);
      for (const r of sortedRows) next.delete(r.opp.id);
      setSelected(next);
    } else {
      const next = new Set(selected);
      for (const r of sortedRows) next.add(r.opp.id);
      setSelected(next);
    }
  };
  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const bulkDelete = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} opportunit${ids.length === 1 ? 'y' : 'ies'}? This cannot be undone.`)) return;
    await window.lh.opps.deleteMany(ids);
    setSelected(new Set());
    await refresh();
  };

  const exportSelected = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setExporting(true);
    try {
      const result = await window.lh.opps.exportXlsx(ids);
      if (result && result.path) {
        setExportToast(`Exported ${result.count} to ${result.path.split('/').pop()}`);
        setTimeout(() => setExportToast(null), 4000);
      }
    } catch (e: any) {
      alert('Export failed: ' + (e?.message || e));
    } finally {
      setExporting(false);
    }
  };

  const sortBy = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'date' || key === 'confidence' ? 'desc' : 'asc');
    }
  };

  const anyFilterActive = Object.entries(filters).some(([, v]) => v !== '');

  return (
    <div>
      <div style={{ marginTop: 16, marginBottom: 8 }}>
        <div className="h-page">Dashboard</div>
        <div style={{ color: '#6b7280', fontSize: 14, marginTop: 4 }}>
          Pipeline overview and open opportunities
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, marginTop: 24 }}>
        <StatCard label="Open Opportunities" value={stats?.open ?? 0} chip="Open" chipKind="open" />
        <StatCard label="Qualified Leads" value={stats?.qualified ?? 0} chip="Qualified" chipKind="qualified" />
        <StatCard label="Disqualified" value={stats?.disqualified ?? 0} chip="Disqualified" chipKind="disqualified" />
        <StatCard label="Active Brands" value={stats?.brands ?? 0} chip="Brands" chipKind="brand" />
      </div>

      <div className="card" style={{ padding: 20, marginTop: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div className="h-card">Last Scan</div>
          <div style={{ color: '#6b7280', fontSize: 13, marginTop: 4 }}>
            {stats?.lastScan
              ? `${fmtDate(stats.lastScan.startedAt)} — ${stats.lastScan.status} — ${stats.lastScan.results} opportunities`
              : 'No scans run yet.'}
          </div>
          {error && <div style={{ color: '#b91c1c', fontSize: 13, marginTop: 6 }}>{error}</div>}
        </div>
        <button className="btn-primary" onClick={runScan} disabled={running}>
          {running ? 'Scanning…' : 'Run Scan Now'}
        </button>
      </div>

      <div style={{ marginTop: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 16, flexWrap: 'wrap' }}>
          <div className="h-section">
            Open Opportunities
            <span style={{ marginLeft: 10, fontSize: 13, fontWeight: 500, color: '#6b7280' }}>
              {sortedRows.length}{anyFilterActive && allRows.length !== sortedRows.length ? ` of ${allRows.length}` : ''}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {anyFilterActive && (
              <button className="btn-ghost" onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</button>
            )}
            {selected.size > 0 && (
              <>
                <span style={{ fontSize: 13, color: '#6b7280' }}>{selected.size} selected</span>
                <button className="btn-ghost" onClick={() => setSelected(new Set())}>Clear</button>
                <button className="btn-ghost" onClick={exportSelected} disabled={exporting}>
                  <Download size={13} style={{ display: 'inline', marginRight: 6, verticalAlign: '-2px' }} />
                  {exporting ? 'Exporting…' : `Export ${selected.size} as Excel`}
                </button>
                <button className="btn-danger" onClick={bulkDelete}>
                  <Trash2 size={13} style={{ display: 'inline', marginRight: 6, verticalAlign: '-2px' }} />
                  Delete {selected.size}
                </button>
              </>
            )}
            {exportToast && (
              <span style={{ fontSize: 13, color: '#065f46' }}>{exportToast}</span>
            )}
          </div>
        </div>
        <div
          className="card"
          style={{
            overflow: 'auto',
            maxHeight: '60vh',
            minHeight: 280
          }}
        >
          <table className="lh" style={{ minWidth: 1180 }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 2 }}>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    ref={(el) => { if (el) el.indeterminate = someVisibleSelected; }}
                    onChange={toggleAllVisible}
                    aria-label="Select all visible"
                  />
                </th>
                <SortableTh label="Date"        k="date"       sortKey={sortKey} sortDir={sortDir} onSort={sortBy} />
                <SortableTh label="Company"     k="company"    sortKey={sortKey} sortDir={sortDir} onSort={sortBy} />
                <SortableTh label="Industry"    k="industry"   sortKey={sortKey} sortDir={sortDir} onSort={sortBy} />
                <SortableTh label="Brand"       k="brand"      sortKey={sortKey} sortDir={sortDir} onSort={sortBy} />
                <SortableTh label="Product"     k="product"    sortKey={sortKey} sortDir={sortDir} onSort={sortBy} />
                <SortableTh label="Scan Type"   k="scanType"   sortKey={sortKey} sortDir={sortDir} onSort={sortBy} />
                <SortableTh label="Confidence"  k="confidence" sortKey={sortKey} sortDir={sortDir} onSort={sortBy} />
                <SortableTh label="Signal Summary" k="signal"  sortKey={sortKey} sortDir={sortDir} onSort={sortBy} />
                <th>Actions</th>
              </tr>
              <tr style={{ background: '#fafafa' }}>
                <th />
                <th />
                <th><FilterInput value={filters.company} onChange={(v) => setFilters({ ...filters, company: v })} placeholder="filter…" /></th>
                <th><FilterInput value={filters.industry} onChange={(v) => setFilters({ ...filters, industry: v })} placeholder="filter…" /></th>
                <th>
                  <FilterSelect value={filters.brand} onChange={(v) => setFilters({ ...filters, brand: v })} options={brandOptions} />
                </th>
                <th>
                  <FilterSelect value={filters.product} onChange={(v) => setFilters({ ...filters, product: v })} options={productOptions} />
                </th>
                <th>
                  <FilterSelect
                    value={filters.scanType}
                    onChange={(v) => setFilters({ ...filters, scanType: (v as ScanType) || '' })}
                    options={['Manual Scan', 'Live Monitor']}
                  />
                </th>
                <th>
                  <input
                    className="filter-input"
                    type="number" min={0} max={100}
                    value={filters.confidenceMin}
                    onChange={(e) => setFilters({ ...filters, confidenceMin: e.target.value })}
                    placeholder="≥ %"
                  />
                </th>
                <th><FilterInput value={filters.signal} onChange={(v) => setFilters({ ...filters, signal: v })} placeholder="filter…" /></th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sortedRows.length === 0 ? (
                <tr>
                  <td colSpan={10} style={{ textAlign: 'center', color: '#6b7280', padding: 28 }}>
                    {allRows.length === 0
                      ? 'No open opportunities. Run a scan to find new leads.'
                      : 'No opportunities match the current filters.'}
                  </td>
                </tr>
              ) : (
                sortedRows.map(({ opp, scanType, brandName, productName }) => (
                  <OppRow
                    key={opp.id}
                    opp={opp}
                    scanType={scanType}
                    brandName={brandName}
                    productName={productName}
                    selected={selected.has(opp.id)}
                    onToggleSelect={() => toggleOne(opp.id)}
                    onOpen={() => onOpenOpp(opp.id)}
                    onDelete={async () => {
                      if (confirm(`Delete the opportunity for ${opp.company}? This cannot be undone.`)) {
                        await window.lh.opps.delete(opp.id);
                        await refresh();
                      }
                    }}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <style>{`
        .filter-input {
          width: 100%;
          min-width: 0;
          border: 1px solid #e5e7eb;
          border-radius: 6px;
          padding: 4px 8px;
          font-size: 12px;
          background: white;
          outline: none;
          color: #111827;
          font-weight: 400;
        }
        .filter-input:focus {
          border-color: #6c5cf2;
          box-shadow: 0 0 0 2px rgba(108,92,242,0.15);
        }
        table.lh thead tr:nth-child(2) th {
          padding: 6px 12px;
          background: #fafafa;
          border-bottom: 1px solid #e5e7eb;
          font-weight: 400;
        }
      `}</style>
    </div>
  );
}

function SortableTh({
  label, k, sortKey, sortDir, onSort
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  const active = sortKey === k;
  return (
    <th
      onClick={() => onSort(k)}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
      title="Click to sort"
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: active ? '#111827' : undefined }}>
        {label}
        {active && (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </span>
    </th>
  );
}

function FilterInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      className="filter-input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  );
}

function FilterSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select className="filter-input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">all</option>
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );
}

function OppRow({
  opp, scanType, brandName, productName, selected, onToggleSelect, onOpen, onDelete
}: {
  opp: Opportunity;
  scanType: ScanType;
  brandName: string;
  productName: string;
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <tr style={selected ? { background: '#f5f3ff' } : undefined}>
      <td>
        <input type="checkbox" checked={selected} onChange={onToggleSelect} aria-label="Select" />
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>{fmtDateShort(opp.created_at)}</td>
      <td style={{ fontWeight: 500 }}>{opp.company}</td>
      <td>{opp.industry || '—'}</td>
      <td>{brandName}</td>
      <td>{productName}</td>
      <td>
        <span className={`chip ${scanType === 'Live Monitor' ? 'chip-qualified' : 'chip-muted'}`} style={{ whiteSpace: 'nowrap' }}>
          {scanType}
        </span>
      </td>
      <td>
        <span className="chip chip-muted">{Math.round((opp.confidence || 0) * 100)}%</span>
      </td>
      <td style={{ maxWidth: 320 }}>{opp.signal_summary}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <button className="btn-ghost" onClick={onOpen}>View</button>{' '}
        <button className="btn-ghost" onClick={() => openExternal(opp.source_url)}>Source</button>{' '}
        <button className="btn-danger" onClick={onDelete}>Delete</button>
      </td>
    </tr>
  );
}
