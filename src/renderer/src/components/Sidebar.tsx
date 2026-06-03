import {
  LayoutGrid, Clock, Filter, Send, Boxes, Archive, Settings as SettingsIcon, Radio, DollarSign
} from 'lucide-react';
import logoUrl from '../assets/logo.png';

export type Page =
  | 'dashboard' | 'monitor' | 'scans' | 'signals' | 'dispatch'
  | 'brands' | 'archive' | 'cost' | 'settings';

export function Sidebar({
  active, onNav
}: { active: Page; onNav: (p: Page) => void }) {
  const items: { id: Page; label: string; icon: any }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutGrid },
    { id: 'monitor', label: 'Live Monitor', icon: Radio },
    { id: 'scans', label: 'Scan Jobs', icon: Clock },
    { id: 'signals', label: 'Signal Config', icon: Filter },
    { id: 'dispatch', label: 'Brand Dispatch', icon: Send },
    { id: 'brands', label: 'Brands & Products', icon: Boxes },
    { id: 'archive', label: 'Archive', icon: Archive },
    { id: 'cost', label: 'Cost Management', icon: DollarSign },
    { id: 'settings', label: 'Settings', icon: SettingsIcon }
  ];
  return (
    <aside
      className="drag flex flex-col justify-between text-gray-200"
      style={{ background: '#1c1d28', width: 240, height: '100vh' }}
    >
      <div>
        <div style={{ height: 36 }} />
        <div className="px-6 pb-6">
          <img
            src={logoUrl}
            alt="LeadsHawk"
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              display: 'block',
              marginBottom: 10,
              boxShadow: '0 1px 2px rgba(0,0,0,0.4)'
            }}
          />
          <div style={{ fontSize: 22, fontWeight: 700, color: 'white' }}>LeadsHawk</div>
          <div style={{ color: '#a78bfa', fontSize: 12, marginTop: 2 }}>B2B Signal Intelligence</div>
        </div>
        <nav className="no-drag px-3 flex flex-col gap-1">
          {items.map((it) => {
            const Icon = it.icon;
            const isActive = active === it.id;
            return (
              <button
                key={it.id}
                onClick={() => onNav(it.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 14px',
                  borderRadius: 10,
                  fontSize: 14,
                  fontWeight: 500,
                  textAlign: 'left',
                  background: isActive ? '#6c5cf2' : 'transparent',
                  color: isActive ? 'white' : '#cbd5e1',
                  border: 'none',
                  cursor: 'pointer',
                  transition: 'background 0.15s'
                }}
                onMouseEnter={(e) => {
                  if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = '#2a2b38';
                }}
                onMouseLeave={(e) => {
                  if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                }}
              >
                <Icon size={18} />
                <span>{it.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
      <div className="no-drag px-6 py-4" style={{ color: '#6b7280', fontSize: 11 }}>
        v1.17.3
      </div>
    </aside>
  );
}
