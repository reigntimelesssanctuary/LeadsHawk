import { useEffect, useState } from 'react';
import type { Opportunity } from '../../../shared/types';
import { fmtDate } from '../lib/api';

export function Archive({ onOpenOpp }: { onOpenOpp: (id: number) => void }) {
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [filter, setFilter] = useState<'all' | 'disqualified' | 'archived'>('all');

  const refresh = async () => {
    if (filter === 'all') {
      const a = await window.lh.opps.list('disqualified');
      const b = await window.lh.opps.list('archived');
      setOpps([...a, ...b].sort((x, y) => (y.updated_at > x.updated_at ? 1 : -1)));
    } else {
      setOpps(await window.lh.opps.list(filter));
    }
  };
  useEffect(() => { refresh(); }, [filter]);

  return (
    <div>
      <div style={{ marginTop: 16, marginBottom: 16 }}>
        <div className="h-page">Archive</div>
        <div style={{ color: '#6b7280', fontSize: 14, marginTop: 4 }}>
          Disqualified and archived opportunities
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {(['all', 'disqualified', 'archived'] as const).map((f) => (
          <button key={f} className={filter === f ? 'btn-primary' : 'btn-ghost'} onClick={() => setFilter(f)}>
            {f[0].toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="lh">
          <thead>
            <tr>
              <th>Updated</th>
              <th>Company</th>
              <th>Status</th>
              <th>Signal</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {opps.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', color: '#6b7280', padding: 28 }}>Nothing here.</td></tr>}
            {opps.map((o) => (
              <tr key={o.id}>
                <td>{fmtDate(o.updated_at)}</td>
                <td style={{ fontWeight: 500 }}>{o.company}</td>
                <td><span className={`chip chip-${o.status}`}>{o.status}</span></td>
                <td style={{ maxWidth: 460 }}>{o.signal_summary}</td>
                <td><button className="btn-ghost" onClick={() => onOpenOpp(o.id)}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
