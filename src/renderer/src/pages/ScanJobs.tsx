import { useEffect, useState } from 'react';
import type { ScanRun, Settings } from '../../../shared/types';
import { fmtDate } from '../lib/api';

export function ScanJobs() {
  const [runs, setRuns] = useState<ScanRun[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [running, setRunning] = useState(false);
  const [selectedRun, setSelectedRun] = useState<ScanRun | null>(null);

  const refresh = async () => {
    setRuns(await window.lh.scan.runs());
    setSettings(await window.lh.settings.get());
  };
  useEffect(() => { refresh(); }, []);

  return (
    <div>
      <div style={{ marginTop: 16, marginBottom: 16 }}>
        <div className="h-page">Scan Jobs</div>
        <div style={{ color: '#6b7280', fontSize: 14, marginTop: 4 }}>
          Autonomous scan schedule and run history
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 20 }}>
        <div className="h-card" style={{ marginBottom: 10 }}>Schedule</div>
        {settings && <ScheduleEditor settings={settings} onSaved={refresh} />}
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div className="h-card">Manual run</div>
          <div style={{ color: '#6b7280', fontSize: 13, marginTop: 4 }}>Trigger a one-off scan now.</div>
        </div>
        <button
          className="btn-primary"
          onClick={async () => {
            setRunning(true);
            try { await window.lh.scan.run(); refresh(); }
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
              <th>Status</th>
              <th>Scanned</th>
              <th>Opportunities</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: '#6b7280', padding: 28 }}>No runs yet.</td></tr>}
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{fmtDate(r.started_at)}</td>
                <td>{fmtDate(r.finished_at)}</td>
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

function ScheduleEditor({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const [cron, setCron] = useState(settings.scanCron);
  const [enabled, setEnabled] = useState(settings.scanEnabled);
  const [saved, setSaved] = useState(false);

  const presets: { label: string; value: string }[] = [
    { label: 'Every hour', value: '0 * * * *' },
    { label: 'Every 6 hours', value: '0 */6 * * *' },
    { label: 'Twice daily', value: '0 9,21 * * *' },
    { label: 'Daily at 9am', value: '0 9 * * *' }
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enable autonomous scans
        </label>
      </div>
      <label className="label">Cron expression</label>
      <input className="input" value={cron} onChange={(e) => setCron(e.target.value)} />
      <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {presets.map((p) => (
          <button key={p.value} className="btn-ghost" onClick={() => setCron(p.value)}>{p.label}</button>
        ))}
      </div>
      <div style={{ marginTop: 14 }}>
        <button className="btn-primary" onClick={async () => {
          await window.lh.settings.update({ scanCron: cron, scanEnabled: enabled });
          setSaved(true); onSaved(); setTimeout(() => setSaved(false), 2000);
        }}>Save schedule</button>
        {saved && <span style={{ marginLeft: 12, color: '#065f46', fontSize: 13 }}>Saved.</span>}
      </div>
    </div>
  );
}
