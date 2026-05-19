import { useState } from 'react';
import { Sidebar, Page } from './components/Sidebar';
import { Dashboard } from './pages/Dashboard';
import { ScanJobs } from './pages/ScanJobs';
import { SignalConfig } from './pages/SignalConfig';
import { BrandDispatch } from './pages/BrandDispatch';
import { BrandsProducts } from './pages/BrandsProducts';
import { Archive } from './pages/Archive';
import { Settings } from './pages/Settings';
import { OpportunityDetail } from './pages/OpportunityDetail';

export default function App() {
  const [page, setPage] = useState<Page>('dashboard');
  const [oppId, setOppId] = useState<number | null>(null);

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar active={page} onNav={(p) => { setPage(p); setOppId(null); }} />
      <main style={{ flex: 1, overflow: 'auto', background: '#f7f7fa' }}>
        <div style={{ height: 28 }} className="drag" />
        <div style={{ padding: '0 32px 32px' }}>
          {oppId !== null ? (
            <OpportunityDetail id={oppId} onClose={() => setOppId(null)} />
          ) : (
            <>
              {page === 'dashboard' && <Dashboard onOpenOpp={(id) => setOppId(id)} />}
              {page === 'scans' && <ScanJobs />}
              {page === 'signals' && <SignalConfig />}
              {page === 'dispatch' && <BrandDispatch onOpenOpp={(id) => setOppId(id)} />}
              {page === 'brands' && <BrandsProducts />}
              {page === 'archive' && <Archive onOpenOpp={(id) => setOppId(id)} />}
              {page === 'settings' && <Settings />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
