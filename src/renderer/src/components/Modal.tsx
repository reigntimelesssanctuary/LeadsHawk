import { X } from 'lucide-react';
import { ReactNode } from 'react';

export function Modal({
  open, onClose, title, children, width = 640
}: { open: boolean; onClose: () => void; title: string; children: ReactNode; width?: number }) {
  if (!open) return null;
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,17,24,0.45)',
        zIndex: 100, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: 80
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width, maxWidth: '90vw', maxHeight: '80vh', overflow: 'auto', padding: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #e5e7eb' }}>
          <div className="h-card">{title}</div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#6b7280' }}>
            <X size={18} />
          </button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  );
}
