import { useEffect, useState } from 'react';
import type { Opportunity } from '../../../shared/types';
import { fmtDate } from '../lib/api';

export function BrandDispatch({ onOpenOpp }: { onOpenOpp: (id: number) => void }) {
  const [opps, setOpps] = useState<Opportunity[]>([]);
  useEffect(() => { window.lh.opps.list('qualified').then(setOpps); }, []);
  return (
    <div>
      <div style={{ marginTop: 16, marginBottom: 16 }}>
        <div className="h-page">Brand Dispatch</div>
        <div style={{ color: '#6b7280', fontSize: 14, marginTop: 4 }}>
          Qualified opportunities ready for sales outreach
        </div>
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="lh">
          <thead>
            <tr>
              <th>Qualified</th>
              <th>Company</th>
              <th>Industry</th>
              <th>Confidence</th>
              <th>Angle</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {opps.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: '#6b7280', padding: 28 }}>Nothing qualified yet. Qualify open opportunities to send them here.</td></tr>}
            {opps.map((o) => (
              <tr key={o.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(o.updated_at)}</td>
                <td style={{ fontWeight: 500 }}>{o.company}</td>
                <td>{o.industry || '—'}</td>
                <td><span className="chip chip-muted">{Math.round((o.confidence || 0) * 100)}%</span></td>
                <td style={{ maxWidth: 360 }}>{o.signal_summary}</td>
                <td><button className="btn-ghost" onClick={() => onOpenOpp(o.id)}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
