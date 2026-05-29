import { useEffect, useMemo, useState } from 'react';
import { StatCard } from '../components/StatCard';
import type { DashboardStats, Opportunity, Brand, Product } from '../../../shared/types';
import { fmtDate, fmtDateShort, openExternal } from '../lib/api';
import { Trash2, Download, ArrowUp, ArrowDown, AlertTriangle, ChevronDown, ChevronRight, Brain } from 'lucide-react';

// v1.16.0 — pipeline summary from the state cache (events.ts/getPipelineSummary).
type PipelineSummary = {
  by_stage: Record<string, number>;
  total_opportunities: number;
  total_won: number;
  total_lost: number;
  total_won_value: number;
  avg_cycle_days: number | null;
  win_rate: number | null;
  closed_this_month: number;
  won_this_month_value: number;
};

// v1.17.0 — learning status from main/learning-signals.ts.
type LearningStatus = {
  total_outcomes_observed: number;
  total_dimensions_tracked: number;
  informing_dimensions: number;
  by_dimension: Array<{
    dimension: string;
    label: string;
    total_rows: number;
    informing_rows: number;
    sample_top: Array<{
      dimension_value: string;
      n_closed_won: number;
      n_closed_lost: number;
      smoothed_close_rate: number;
      meets_threshold: boolean;
    }>;
  }>;
};

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

type SortKey = 'date' | 'company' | 'industry' | 'country' | 'brand' | 'product' | 'scanType' | 'confidence' | 'signal';
type SortDir = 'asc' | 'desc';

type Filters = {
  company: string;
  industry: string;
  country: string;   // exact match by country name; '' = all
  brand: string;     // exact match by name; '' = all
  product: string;
  scanType: '' | ScanType;
  confidenceMin: string; // numeric string 0-100; '' = all
  signal: string;
};

const EMPTY_FILTERS: Filters = {
  company: '',
  industry: '',
  country: '',
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
  // v1.16.0 — pipeline summary + stale-id set for the lifecycle widgets.
  const [pipeline, setPipeline] = useState<PipelineSummary | null>(null);
  const [staleIds, setStaleIds] = useState<Set<number>>(new Set());
  // v1.17.0 — learning status (per-dimension counts + informing rows).
  const [learning, setLearning] = useState<LearningStatus | null>(null);

  const refresh = async () => {
    const [s, list, bs, ps, pipe, stale, learn] = await Promise.all([
      window.lh.dashboard.stats(),
      window.lh.opps.list('open'),
      window.lh.brands.list(),
      window.lh.products.list(),
      window.lh.pipeline.summary().catch(() => null),
      window.lh.pipeline.staleIds(14).catch(() => [] as number[]),
      window.lh.learning.status().catch(() => null)
    ]);
    setStats(s);
    setOpps(list);
    setBrands(bs);
    setProducts(ps);
    setPipeline(pipe);
    setStaleIds(new Set(stale));
    setLearning(learn);
    setSelected((prev) => {
      const liveIds = new Set(list.map((o: Opportunity) => o.id));
      const next = new Set<number>();
      for (const id of prev) if (liveIds.has(id)) next.add(id);
      return next;
    });
  };

  useEffect(() => { refresh(); }, []);

  // v1.12.0: manual scan retired. Dashboard's "Run Scan Now" button
  // now triggers the deep-scan pipeline (two-stage Opus-qualified by
  // default; configurable in Settings).
  const runScan = async () => {
    setRunning(true); setError(null);
    try {
      await window.lh.scan.runDeep();
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
      if (filters.country && (r.opp.country || '') !== filters.country) return false;
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
        case 'country':    return (a.opp.country || '').localeCompare(b.opp.country || '') * dir;
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
  const countryOptions = useMemo(
    () => Array.from(new Set(allRows.map((r) => r.opp.country || '').filter((c) => c.length > 0))).sort(),
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

      {/* v1.16.0 — lifecycle widget row. Reads from opportunity_state_cache. */}
      <div style={{ display: 'flex', gap: 16, marginTop: 24, flexWrap: 'wrap' }}>
        <PipelineCard
          label="New"
          value={(pipeline?.by_stage['created'] ?? 0) + (pipeline?.by_stage['delivered'] ?? 0)}
          sub="awaiting decision"
          chipKind="open"
        />
        <PipelineCard
          label="Working pipeline"
          value={(pipeline?.by_stage['accepted'] ?? 0) + (pipeline?.by_stage['engaged'] ?? 0) + (pipeline?.by_stage['proposal_sent'] ?? 0)}
          sub="accepted → proposal sent"
          chipKind="qualified"
        />
        <PipelineCard
          label="Won this month"
          value={pipeline?.closed_this_month ? `${pipeline.by_stage['closed_won'] ?? 0}` : '0'}
          sub={pipeline && pipeline.won_this_month_value > 0
            ? `$${pipeline.won_this_month_value.toLocaleString()}`
            : 'no value recorded'}
          chipKind="qualified"
        />
        <PipelineCard
          label="Win rate"
          value={pipeline?.win_rate !== null && pipeline?.win_rate !== undefined
            ? `${Math.round(pipeline.win_rate * 100)}%`
            : '—'}
          sub={pipeline && (pipeline.total_won + pipeline.total_lost) > 0
            ? `${pipeline.total_won}W / ${pipeline.total_lost}L`
            : 'need ≥ 3 closed deals'}
          chipKind={(pipeline?.win_rate ?? 0) > 0.4 ? 'qualified' : 'open'}
        />
        <PipelineCard
          label="Active brands"
          value={stats?.brands ?? 0}
          sub="in portfolio"
          chipKind="brand"
        />
      </div>

      {/* Legacy aggregates — left in for back-compat during v1.16. Will be
          removed in v1.17 once users are reading the lifecycle widget. */}
      <div style={{ display: 'flex', gap: 16, marginTop: 16 }}>
        <StatCard label="Open" value={stats?.open ?? 0} chip="Open" chipKind="open" />
        <StatCard label="Qualified" value={stats?.qualified ?? 0} chip="Qualified" chipKind="qualified" />
        <StatCard label="Disqualified" value={stats?.disqualified ?? 0} chip="Disqualified" chipKind="disqualified" />
      </div>

      {/* v1.17.0 — Learning status card. Surfaces what the learning loop
          knows so far, which dimensions are informing scoring, and which
          are still too thin to weigh in. Collapsible. */}
      <LearningStatusCard status={learning} />

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
          <table className="lh" style={{ minWidth: 1280 }}>
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
                <SortableTh label="Country"     k="country"    sortKey={sortKey} sortDir={sortDir} onSort={sortBy} />
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
                  <FilterSelect value={filters.country} onChange={(v) => setFilters({ ...filters, country: v })} options={countryOptions} />
                </th>
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
                  <td colSpan={11} style={{ textAlign: 'center', color: '#6b7280', padding: 28 }}>
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
                    isStale={staleIds.has(opp.id)}
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
  opp, scanType, brandName, productName, selected, isStale, onToggleSelect, onOpen, onDelete
}: {
  opp: Opportunity;
  scanType: ScanType;
  brandName: string;
  productName: string;
  selected: boolean;
  isStale: boolean;
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
      <td style={{ fontWeight: 500 }}>
        {opp.company}
        {isStale && (
          <span
            className="chip"
            style={{
              marginLeft: 8,
              background: '#fef3c7',
              color: '#92400e',
              fontSize: 10,
              padding: '2px 6px',
              verticalAlign: 'middle'
            }}
            title="No lifecycle event in the last 14 days — this opportunity may be stalled"
          >
            <AlertTriangle size={10} style={{ display: 'inline', marginRight: 3, verticalAlign: '-1px' }} />
            stale
          </span>
        )}
      </td>
      <td>{opp.industry || '—'}</td>
      <td style={{ whiteSpace: 'nowrap' }}>{opp.country || '—'}</td>
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

// v1.16.0 — pipeline-aware stat card variant. Same shape as StatCard but
// with a value+sub layout that suits "X · $89k" or "12% · 3W/4L" pairs.
function PipelineCard({
  label, value, sub, chipKind
}: {
  label: string;
  value: string | number;
  sub: string;
  chipKind: 'open' | 'qualified' | 'disqualified' | 'brand' | 'archived' | 'muted';
}) {
  return (
    <div className="card" style={{ padding: 16, minWidth: 180, flex: 1 }}>
      <div className="label" style={{ marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 28, fontWeight: 700, color: '#111827', lineHeight: 1 }}>{value}</div>
        <span className={`chip chip-${chipKind}`} style={{ fontSize: 11 }}>{sub}</span>
      </div>
    </div>
  );
}

// v1.17.0 — Learning status card. Surfaces what the learning loop knows
// so far, which dimensions are informing scoring, and which are still
// too thin. Collapsible; collapsed by default to keep the Dashboard quiet
// for users in cold-start phase.
function LearningStatusCard({ status }: { status: LearningStatus | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!status) return null;

  const informing = status.informing_dimensions;
  const total = status.total_dimensions_tracked;
  const outcomes = status.total_outcomes_observed;

  // Headline summary line — varies by maturity.
  const headline = (() => {
    if (outcomes === 0) {
      return 'No outcomes captured yet. Mark opportunities Closed-won or Closed-lost on Opportunity Detail to start training the learning loop.';
    }
    if (informing === 0) {
      return `Tracking ${total} dimension/value combinations across ${outcomes} closed deals. None yet meet the ≥5 won AND ≥5 lost threshold to influence scoring.`;
    }
    return `Tracking ${total} dimension/value combinations across ${outcomes} closed deals. ${informing} ${informing === 1 ? 'dimension is' : 'dimensions are'} currently influencing Stage 2 scoring (±0.15 cap).`;
  })();

  return (
    <div className="card" style={{ padding: 20, marginTop: 20 }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', width: '100%', textAlign: 'left' }}
      >
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <Brain size={16} style={{ color: '#6c5cf2' }} />
        <span className="h-card" style={{ flex: 1 }}>Learning status</span>
        {outcomes > 0 && (
          <span className={`chip ${informing > 0 ? 'chip-qualified' : 'chip-muted'}`} style={{ fontSize: 11 }}>
            {informing > 0 ? `${informing} informing` : 'cold start'}
          </span>
        )}
      </button>
      <div style={{ fontSize: 13, color: '#6b7280', marginTop: 8 }}>{headline}</div>

      {expanded && status.by_dimension.length > 0 && (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {status.by_dimension.map((dim) => (
            <div key={dim.dimension} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{dim.label}</span>
                <span style={{ fontSize: 12, color: '#6b7280' }}>
                  {dim.total_rows} value{dim.total_rows === 1 ? '' : 's'} tracked
                </span>
                {dim.informing_rows > 0 && (
                  <span className="chip chip-qualified" style={{ fontSize: 10 }}>
                    {dim.informing_rows} informing
                  </span>
                )}
              </div>
              {dim.sample_top.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {dim.sample_top.map((row) => {
                    const pct = Math.round(row.smoothed_close_rate * 100);
                    return (
                      <div
                        key={row.dimension_value}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          fontSize: 12,
                          color: '#1f2937',
                          padding: '3px 0'
                        }}
                      >
                        <span
                          style={{
                            display: 'inline-block',
                            minWidth: 38,
                            textAlign: 'right',
                            fontVariantNumeric: 'tabular-nums',
                            color: row.meets_threshold ? '#111827' : '#9ca3af',
                            fontWeight: 600
                          }}
                        >
                          {pct}%
                        </span>
                        <span style={{ flex: 1, color: row.meets_threshold ? '#1f2937' : '#9ca3af' }}>
                          {row.dimension_value}
                        </span>
                        <span style={{ color: '#6b7280', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
                          {row.n_closed_won}W / {row.n_closed_lost}L
                        </span>
                        {!row.meets_threshold && (
                          <span className="chip chip-muted" style={{ fontSize: 10 }} title="Need ≥5 won AND ≥5 lost to influence scoring">
                            too thin
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>
                  No outcomes yet.
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
