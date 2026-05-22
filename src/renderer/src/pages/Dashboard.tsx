import { useEffect, useState } from 'react';
import { StatCard } from '../components/StatCard';
import type { DashboardStats, Opportunity } from '../../../shared/types';
import { fmtDate, fmtDateShort, openExternal } from '../lib/api';

export function Dashboard({ onOpenOpp }: { onOpenOpp: (id: number) => void }) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setStats(await window.lh.dashboard.stats());
    setOpps(await window.lh.opps.list('open'));
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
        <div className="h-section" style={{ marginBottom: 12 }}>Open Opportunities</div>
        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="lh">
            <thead>
              <tr>
                <th>Date</th>
                <th>Company</th>
                <th>Industry</th>
                <th>Brand</th>
                <th>Product</th>
                <th>Confidence</th>
                <th>Signal Summary</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {opps.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', color: '#6b7280', padding: 28 }}>
                    No open opportunities. Run a scan to find new leads.
                  </td>
                </tr>
              ) : (
                opps.map((o) => (
                  <OppRow
                    key={o.id}
                    opp={o}
                    onOpen={() => onOpenOpp(o.id)}
                    onDelete={async () => {
                      if (confirm(`Delete the opportunity for ${o.company}? This cannot be undone.`)) {
                        await window.lh.opps.delete(o.id);
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
  opp, onOpen, onDelete
}: { opp: Opportunity; onOpen: () => void; onDelete: () => void }) {
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
    <tr>
      <td style={{ whiteSpace: 'nowrap' }}>{fmtDateShort(opp.created_at)}</td>
      <td style={{ fontWeight: 500 }}>{opp.company}</td>
      <td>{opp.industry || '—'}</td>
      <td>{brandName}</td>
      <td>{productName}</td>
      <td>
        <span className="chip chip-muted">{Math.round((opp.confidence || 0) * 100)}%</span>
      </td>
      <td style={{ maxWidth: 360 }}>{opp.signal_summary}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <button className="btn-ghost" onClick={onOpen}>View</button>{' '}
        <button className="btn-ghost" onClick={() => openExternal(opp.source_url)}>Source</button>{' '}
        <button className="btn-danger" onClick={onDelete}>Delete</button>
      </td>
    </tr>
  );
}
