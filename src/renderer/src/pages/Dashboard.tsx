import { useEffect, useMemo, useState } from 'react';
import { StatCard } from '../components/StatCard';
import type { DashboardStats, Opportunity } from '../../../shared/types';
import { fmtDate, fmtDateShort, openExternal } from '../lib/api';
import { Trash2 } from 'lucide-react';

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

export function Dashboard({ onOpenOpp }: { onOpenOpp: (id: number) => void }) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const refresh = async () => {
    setStats(await window.lh.dashboard.stats());
    const list = await window.lh.opps.list('open');
    setOpps(list);
    // Drop selections for opportunities that no longer exist
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

  const allSelected = opps.length > 0 && selected.size === opps.length;
  const someSelected = selected.size > 0 && selected.size < opps.length;
  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(opps.map((o) => o.id)));
  };
  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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

  const rowsWithType = useMemo(
    () => opps.map((o) => ({ opp: o, scanType: scanTypeOf(o) })),
    [opps]
  );

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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div className="h-section">Open Opportunities</div>
          {selected.size > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 13, color: '#6b7280' }}>{selected.size} selected</span>
              <button className="btn-ghost" onClick={() => setSelected(new Set())}>Clear</button>
              <button className="btn-danger" onClick={bulkDelete}>
                <Trash2 size={13} style={{ display: 'inline', marginRight: 6, verticalAlign: '-2px' }} />
                Delete {selected.size}
              </button>
            </div>
          )}
        </div>
        <div className="card" style={{ overflowX: 'auto', overflowY: 'hidden' }}>
          <table className="lh" style={{ minWidth: 1080 }}>
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = someSelected; }}
                    onChange={toggleAll}
                    aria-label="Select all"
                  />
                </th>
                <th>Date</th>
                <th>Company</th>
                <th>Industry</th>
                <th>Brand</th>
                <th>Product</th>
                <th>Scan Type</th>
                <th>Confidence</th>
                <th>Signal Summary</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {opps.length === 0 ? (
                <tr>
                  <td colSpan={10} style={{ textAlign: 'center', color: '#6b7280', padding: 28 }}>
                    No open opportunities. Run a scan to find new leads.
                  </td>
                </tr>
              ) : (
                rowsWithType.map(({ opp, scanType }) => (
                  <OppRow
                    key={opp.id}
                    opp={opp}
                    scanType={scanType}
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
    </div>
  );
}

function OppRow({
  opp, scanType, selected, onToggleSelect, onOpen, onDelete
}: {
  opp: Opportunity;
  scanType: ScanType;
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [brandName, setBrandName] = useState<string>('—');
  const [productName, setProductName] = useState<string>('—');
  useEffect(() => {
    (async () => {
      if (opp.brand_id) {
        const b = await window.lh.brands.get(opp.brand_id);
        setBrandName(b?.name || '—');
      }
      if (opp.product_id) {
        const p = await window.lh.products.get(opp.product_id);
        setProductName(p?.name || '—');
      }
    })();
  }, [opp.id]);
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
