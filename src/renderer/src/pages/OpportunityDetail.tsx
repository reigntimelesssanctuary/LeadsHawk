import { useEffect, useState } from 'react';
import type { Opportunity, Brand, Product } from '../../../shared/types';
import { fmtDate, openExternal } from '../lib/api';
import { ArrowLeft, Sparkles, CheckCircle2, XCircle, Archive as ArchiveIcon, ExternalLink } from 'lucide-react';

export function OpportunityDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const [opp, setOpp] = useState<Opportunity | null>(null);
  const [brand, setBrand] = useState<Brand | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [brief, setBrief] = useState<string>('');
  const [generating, setGenerating] = useState(false);

  const refresh = async () => {
    const o = await window.lh.opps.get(id);
    setOpp(o);
    setBrand(o.brand_id ? await window.lh.brands.get(o.brand_id) : null);
    setProduct(o.product_id ? await window.lh.products.get(o.product_id) : null);
  };
  useEffect(() => { refresh(); }, [id]);

  if (!opp) return <div style={{ padding: 24, color: '#6b7280' }}>Loading…</div>;

  const setStatus = async (s: string) => {
    await window.lh.opps.setStatus(id, s);
    refresh();
  };

  const disqualify = async () => {
    const reason = window.prompt(
      'Optional — why disqualify this lead?\n(Leave blank to just mark it; a one-liner helps LeadsHawk learn what to filter out next time.)',
      ''
    );
    if (reason === null) return; // user pressed Cancel
    await window.lh.opps.disqualify(id, reason);
    refresh();
  };

  const generateBrief = async () => {
    setGenerating(true);
    try {
      const out = await window.lh.opps.brief(id);
      setBrief(out);
    } catch (e: any) { alert(e.message); }
    finally { setGenerating(false); }
  };

  return (
    <div>
      <div style={{ marginTop: 16, marginBottom: 16 }}>
        <button className="btn-ghost" onClick={onClose}>
          <ArrowLeft size={14} style={{ display: 'inline', marginRight: 4 }} /> Back
        </button>
      </div>

      <div className="card" style={{ padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div>
            <div style={{ color: '#6b7280', fontSize: 13 }}>{opp.industry || ''}</div>
            <div className="h-page" style={{ marginTop: 4 }}>{opp.company}</div>
            <div style={{ marginTop: 12, color: '#1f2937', fontSize: 15 }}>{opp.signal_summary}</div>
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              {brand && <span className="chip chip-brand">{brand.name}</span>}
              {product && <span className="chip chip-muted">{product.name}</span>}
              <span className={`chip chip-${opp.status}`}>{opp.status}</span>
              <span className="chip chip-muted">{Math.round((opp.confidence || 0) * 100)}% confidence</span>
            </div>
            {opp.status === 'disqualified' && opp.disqualify_reason && (
              <div style={{ marginTop: 12, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 13, color: '#991b1b' }}>
                <span style={{ fontWeight: 600 }}>Disqualified:</span> {opp.disqualify_reason}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-ghost" onClick={() => setStatus('qualified')}>
              <CheckCircle2 size={14} style={{ display: 'inline', marginRight: 4 }} /> Qualify
            </button>
            <button className="btn-ghost" onClick={disqualify}>
              <XCircle size={14} style={{ display: 'inline', marginRight: 4 }} /> Disqualify
            </button>
            <button className="btn-ghost" onClick={() => setStatus('archived')}>
              <ArchiveIcon size={14} style={{ display: 'inline', marginRight: 4 }} /> Archive
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <Section title="Background">{opp.background}</Section>
        <Section title="Justified use case">{opp.use_case}</Section>
        <Section title="Recommended sales angle">{opp.angle}</Section>
        <Section title="Source">
          <div style={{ fontSize: 14 }}>
            <div style={{ fontWeight: 500 }}>{opp.headline}</div>
            <div style={{ color: '#6b7280', fontSize: 13, marginTop: 4 }}>
              {opp.source_title} {opp.source_published_at && '· ' + fmtDate(opp.source_published_at)}
            </div>
            <button className="btn-ghost" style={{ marginTop: 10 }} onClick={() => openExternal(opp.source_url)}>
              <ExternalLink size={13} style={{ display: 'inline', marginRight: 4 }} /> Open source
            </button>
            <AlternativeSources rawSignal={opp.raw_signal} />
          </div>
        </Section>
      </div>

      <div className="card" style={{ padding: 20, marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="h-section">Sales brief</div>
          <button className="btn-primary" onClick={generateBrief} disabled={generating}>
            <Sparkles size={14} style={{ display: 'inline', marginRight: 6 }} />
            {generating ? 'Generating…' : (brief ? 'Regenerate' : 'Generate brief')}
          </button>
        </div>
        {brief && (
          <div className="prose-output" style={{ marginTop: 16 }}>{brief}</div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: 18 }}>
      <div className="label" style={{ marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 14, color: '#1f2937', whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{children || '—'}</div>
    </div>
  );
}

/**
 * v1.5.4: if the primary source link is dead, the scanner now also stores
 * up to 8 alternative citations from the Perplexity response. Surface them
 * here so the user has a fallback.
 */
function AlternativeSources({ rawSignal }: { rawSignal: string | null }) {
  if (!rawSignal) return null;
  let alts: string[] = [];
  let urlSource: string | undefined;
  try {
    const parsed = JSON.parse(rawSignal);
    alts = Array.isArray(parsed?.alt_sources) ? parsed.alt_sources : [];
    urlSource = typeof parsed?.url_source === 'string' ? parsed.url_source : undefined;
  } catch { /* not JSON or malformed — ignore */ }
  if (alts.length === 0 && !urlSource) return null;
  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed #e5e7eb' }}>
      {urlSource === 'citation' && (
        <div style={{ fontSize: 12, color: '#92400e', background: '#fef3c7', padding: '6px 10px', borderRadius: 6, marginBottom: 8 }}>
          The primary source URL was substituted from Perplexity's citations (the LLM's stated URL didn't match a real citation).
        </div>
      )}
      {urlSource === 'llm_unverified' && (
        <div style={{ fontSize: 12, color: '#92400e', background: '#fef3c7', padding: '6px 10px', borderRadius: 6, marginBottom: 8 }}>
          The source URL came directly from the LLM and wasn't verified against Perplexity's citations — if it's broken, no citations were available to substitute.
        </div>
      )}
      {alts.length > 0 && (
        <>
          <div className="label" style={{ marginBottom: 6 }}>Alternative sources</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {alts.map((url) => (
              <a
                key={url}
                onClick={() => openExternal(url)}
                style={{ fontSize: 13, cursor: 'pointer', wordBreak: 'break-all' }}
                title={url}
              >
                {url}
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
