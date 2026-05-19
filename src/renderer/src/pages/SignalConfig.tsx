import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import type { SignalSource } from '../../../shared/types';
import { Plus, Trash2 } from 'lucide-react';

export function SignalConfig() {
  const [sources, setSources] = useState<SignalSource[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const refresh = async () => setSources(await window.lh.sources.list());
  useEffect(() => { refresh(); }, []);

  const toggle = async (s: SignalSource) => {
    await window.lh.sources.update(s.id, { enabled: s.enabled ? 0 : 1 });
    refresh();
  };

  return (
    <div>
      <div style={{ marginTop: 16, marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <div className="h-page">Signal Config</div>
          <div style={{ color: '#6b7280', fontSize: 14, marginTop: 4 }}>
            Sources LeadsHawk monitors for buying signals
          </div>
        </div>
        <button className="btn-primary" onClick={() => setShowAdd(true)}>
          <Plus size={14} style={{ display: 'inline', marginRight: 6 }} /> Add Source
        </button>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="lh">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Config</th>
              <th>Enabled</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sources.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: 'center', color: '#6b7280', padding: 28 }}>No sources configured.</td></tr>
            )}
            {sources.map((s) => {
              const cfg = JSON.parse(s.config || '{}');
              return (
                <tr key={s.id}>
                  <td style={{ fontWeight: 500 }}>{s.name}</td>
                  <td><span className="chip chip-muted">{s.kind}</span></td>
                  <td style={{ color: '#6b7280', maxWidth: 360 }}>{cfg.query || cfg.url || JSON.stringify(cfg)}</td>
                  <td>
                    <label style={{ cursor: 'pointer' }}>
                      <input type="checkbox" checked={!!s.enabled} onChange={() => toggle(s)} />
                    </label>
                  </td>
                  <td>
                    <button className="btn-danger" onClick={async () => { if (confirm('Delete source?')) { await window.lh.sources.delete(s.id); refresh(); } }}>
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add Signal Source">
        <AddSourceForm onDone={async () => { setShowAdd(false); refresh(); }} />
      </Modal>
    </div>
  );
}

function AddSourceForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'google_news' | 'rss'>('google_news');
  const [query, setQuery] = useState('');
  const [url, setUrl] = useState('');
  return (
    <div>
      <label className="label">Name</label>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      <div style={{ height: 12 }} />
      <label className="label">Kind</label>
      <select className="select" value={kind} onChange={(e) => setKind(e.target.value as any)}>
        <option value="google_news">Google News query</option>
        <option value="rss">RSS feed URL</option>
      </select>
      <div style={{ height: 12 }} />
      {kind === 'google_news' ? (
        <>
          <label className="label">Query</label>
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder='"new CIO" OR datacenter outage' />
        </>
      ) : (
        <>
          <label className="label">RSS URL</label>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/feed.xml" />
        </>
      )}
      <div style={{ marginTop: 14, textAlign: 'right' }}>
        <button className="btn-primary" disabled={!name || (kind === 'google_news' ? !query : !url)} onClick={async () => {
          await window.lh.sources.create({
            name, kind,
            config: JSON.stringify(kind === 'google_news' ? { query } : { url }),
            enabled: 1
          });
          onDone();
        }}>Save Source</button>
      </div>
    </div>
  );
}
