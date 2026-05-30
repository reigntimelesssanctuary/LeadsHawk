import { useEffect, useState } from 'react';
import type { Brand, Product, KnowledgeItem, StrategicIntel, IcpSegment, ConfidenceLevels, ConfidenceLevel, ResearchStatusDetail, FactCheckReport, FactCheckSectionVerdict, FactCheckFlaggedClaim } from '../../../shared/types';
import type { Page } from '../components/Sidebar';
import { Modal } from '../components/Modal';
import { FeedbackModal } from '../components/FeedbackModal';
import { Plus, FileText, Link2, NotebookPen, Sparkles, Trash2, Pencil, AlertTriangle, MessageSquare, ChevronDown, ChevronRight } from 'lucide-react';
import { openExternal, fmtDateShort } from '../lib/api';

// v1.10.0 — helpers for rendering Opus Stage 2 + Stage 3 output.
function parseConfidenceLevels(raw: string | null): ConfidenceLevels | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j as ConfidenceLevels : null;
  } catch { return null; }
}
function parseStrategicIntel(raw: string | null): StrategicIntel | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || !Array.isArray(j.icp_segments)) return null;
    return j as StrategicIntel;
  } catch { return null; }
}
function parseFactCheckReport(raw: string | null): FactCheckReport | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || !j.per_section_verdicts) return null;
    return j as FactCheckReport;
  } catch { return null; }
}
function ConfidencePill({ level }: { level: ConfidenceLevel | undefined }) {
  if (!level) return null;
  const styles: Record<ConfidenceLevel, { bg: string; fg: string; label: string }> = {
    high:   { bg: '#d1fae5', fg: '#065f46', label: 'high confidence' },
    medium: { bg: '#fef3c7', fg: '#92400e', label: 'medium confidence' },
    low:    { bg: '#fee2e2', fg: '#991b1b', label: 'low confidence' }
  };
  const s = styles[level];
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        padding: '2px 6px',
        borderRadius: 4,
        background: s.bg,
        color: s.fg,
        marginLeft: 8,
        verticalAlign: 'middle'
      }}
      title="Confidence assigned by the Opus verification pass (Stage 2)."
    >
      {s.label}
    </span>
  );
}
function UnknownsBlock({ unknowns }: { unknowns: string | null }) {
  if (!unknowns || !unknowns.trim()) return null;
  return (
    <div style={{
      marginTop: 14, padding: 12,
      background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8
    }}>
      <div className="label" style={{ marginBottom: 6, color: '#92400e' }}>
        <AlertTriangle size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: '-1px' }} />
        What we don't know
      </div>
      <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, color: '#1f2937', lineHeight: 1.5 }}>{unknowns}</div>
    </div>
  );
}
function StrategicIntelBlock({ intel }: { intel: StrategicIntel | null }) {
  const [open, setOpen] = useState(false);
  if (!intel) return null;
  return (
    <div style={{ marginTop: 14, padding: 12, background: '#f3f4ff', borderRadius: 8 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', width: '100%', textAlign: 'left' }}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span style={{ fontWeight: 600, fontSize: 13, color: '#4c1d95' }}>
          Strategic Intelligence (Claude Opus)
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6b7280' }}>
          {intel.icp_segments.length} ICP segment{intel.icp_segments.length === 1 ? '' : 's'}
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 12, display: 'grid', gap: 14 }}>
          {intel.icp_segments.length > 0 && (
            <div>
              <div className="label" style={{ marginBottom: 8 }}>ICP segments</div>
              <div style={{ display: 'grid', gap: 10 }}>
                {intel.icp_segments.map((seg, i) => (
                  <IcpSegmentCard key={i} segment={seg} />
                ))}
              </div>
            </div>
          )}
          {intel.buying_cycle_scenarios && (
            <div>
              <div className="label" style={{ marginBottom: 6 }}>Buying cycle scenarios</div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, color: '#1f2937', lineHeight: 1.6 }}>{intel.buying_cycle_scenarios}</div>
            </div>
          )}
          {intel.competitive_plays && (
            <div>
              <div className="label" style={{ marginBottom: 6 }}>Competitive plays</div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, color: '#1f2937', lineHeight: 1.6 }}>{intel.competitive_plays}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
// v1.10.1 — surface per-stage research status so silent Opus failures
// are visible without checking the terminal log.
function parseStatusDetail(raw: string | null): ResearchStatusDetail | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;
    return j as ResearchStatusDetail;
  } catch { return null; }
}
/**
 * v1.10.3: extract Stage 4 source coverage ratio from a partial status string.
 * Format: "partial: 9/10 sources verified ..." → 0.9
 * Returns null when the string isn't a partial-with-ratio.
 * Exported for smoke testing.
 */
export function stage4SourceCoverage(stage4Status: string | undefined): number | null {
  if (!stage4Status) return null;
  const m = stage4Status.match(/(\d+)\s*\/\s*(\d+)\s*sources/i);
  if (!m) return null;
  const fetched = Number(m[1]);
  const attempted = Number(m[2]);
  if (!Number.isFinite(fetched) || !Number.isFinite(attempted) || attempted <= 0) return null;
  return fetched / attempted;
}

/**
 * v1.17.2: decide which dossier-status labels ("Opus verified",
 * "+ fact-checked") to display in the dossier header.
 *
 * The labels must reflect the LATEST research attempt's outcome, not
 * persistent timestamps from previous successful runs. Pre-v1.17.2 the
 * labels gated on `last_advanced_research_at` and `last_fact_check_at`
 * (persistent), which meant a failed re-research left the labels lying
 * about the current state.
 *
 * Semantics:
 *   - verified:    Latest run's Stage 2 completed.
 *   - factChecked: Latest run's Stage 4 completed or partial.
 *
 * Fallback: if status_detail is null/malformed (e.g. pre-v1.10.1 row
 * that never had a status write), fall back to the timestamps so the
 * label doesn't disappear from legacy data.
 *
 * Pure helper, exported for smoke testing.
 */
export function dossierLabelState(
  statusDetailRaw: string | null,
  lastAdvancedAt: string | null,
  lastFactCheckAt: string | null
): { verified: boolean; factChecked: boolean } {
  const parsed = parseStatusDetail(statusDetailRaw);
  if (parsed && (parsed.stage2 || parsed.stage1)) {
    // Latest run's status is authoritative.
    const stage2Ok = parsed.stage2 === 'completed';
    const stage4Ok = parsed.stage4 === 'completed' ||
                     (!!parsed.stage4 && /^partial:/.test(parsed.stage4));
    return { verified: stage2Ok, factChecked: stage4Ok };
  }
  // Legacy fallback — no status_detail to read from.
  return {
    verified: !!lastAdvancedAt,
    factChecked: !!lastFactCheckAt
  };
}

function ResearchStatusChip({ raw }: { raw: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const parsed = parseStatusDetail(raw);
  if (!parsed) return null;

  const isFail = (s: string | undefined) => !!s && /^failed:/.test(s);
  const isSkip = (s: string | undefined) => !!s && /^skipped:/.test(s);
  const isPartial = (s: string | undefined) => !!s && /^partial:/.test(s);
  const isOk = (s: string | undefined) => s === 'completed';

  const stage4 = parsed.stage4; // v1.10.2 — may be undefined on pre-1.10.2 records
  const anyFailed = isFail(parsed.stage2) || isFail(parsed.stage3) || isFail(stage4);
  const stage2Skipped = isSkip(parsed.stage2);

  // v1.10.3: smarter Stage 4 partial classification by source-coverage ratio.
  // 9/10 (90% coverage) should read as green-with-note, not amber.
  // Threshold: ≥80% coverage = effectively complete (small amount of paywalled
  // sources is normal); 50-79% = amber warning; <50% = red.
  const stage4Coverage = isPartial(stage4) ? stage4SourceCoverage(stage4) : null;
  const stage4PartialHigh = stage4Coverage !== null && stage4Coverage >= 0.8;
  const stage4PartialMid  = stage4Coverage !== null && stage4Coverage >= 0.5 && stage4Coverage < 0.8;
  const stage4PartialLow  = stage4Coverage !== null && stage4Coverage < 0.5;

  // v1.17.1: an explicitly-SKIPPED stage4 (toggle off, etc.) should count
  // as green-equivalent. The user deliberately turned it off; surfacing
  // the rest of the pipeline as green is more accurate than falling
  // through to "pending" (the pre-v1.17.1 behavior). The summary string
  // still renders "Stage 4 –" so the user sees the explicit dash and
  // understands Stage 4 wasn't run.
  const stage4SkippedExplicit = isSkip(stage4);
  const stagesGreen = isOk(parsed.stage1) && isOk(parsed.stage2) && isOk(parsed.stage3) &&
                      (stage4 === undefined || isOk(stage4) || stage4PartialHigh || stage4SkippedExplicit);
  const stagesAmber = !stagesGreen && (stage2Skipped || stage4PartialMid);
  const stagesRed   = anyFailed || stage4PartialLow;

  const palette = stagesRed
    ? { bg: '#fef2f2', fg: '#991b1b', border: '#fecaca' }
    : stagesAmber
    ? { bg: '#fef3c7', fg: '#92400e', border: '#fde68a' }
    : stagesGreen
    ? { bg: '#d1fae5', fg: '#065f46', border: '#a7f3d0' }
    : { bg: '#f3f4f6', fg: '#4b5563', border: '#e5e7eb' };

  // v1.10.2/v1.10.3: stage symbols.
  const stageSymbol = (s: string | undefined): string => {
    if (isOk(s)) return '✓';
    if (isPartial(s)) {
      if (stage4PartialHigh) return '✓'; // green-tier partial reads as ✓
      if (stage4PartialMid) return '⚠';
      return '✗';
    }
    if (isSkip(s)) return '–';
    return '✗';
  };
  const stagePart = (n: number, s: string | undefined) =>
    s === undefined ? '' : ` · Stage ${n} ${stageSymbol(s)}`;

  // Optional K/N coverage note for high-but-partial Stage 4.
  const coverageNote = stage4PartialHigh && stage4Coverage !== null
    ? ` (${Math.round(stage4Coverage * 100)}% sources)`
    : '';

  const summary = stage2Skipped
    ? `Stage 1 only · Opus skipped`
    : stagesGreen
    ? `Stage 1 ✓ · Stage 2 ✓ · Stage 3 ✓${stage4 ? ` · Stage 4 ${stageSymbol(stage4)}${coverageNote}` : ''}`
    : (stagesRed || stagesAmber)
    ? `Stage 2 ${stageSymbol(parsed.stage2)}${stagePart(3, parsed.stage3)}${stagePart(4, stage4)}`
    : 'pending';

  return (
    <div style={{ marginTop: 8 }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          borderRadius: 12,
          background: palette.bg,
          color: palette.fg,
          border: `1px solid ${palette.border}`,
          fontSize: 12,
          fontWeight: 500,
          cursor: 'pointer'
        }}
        title="Click for full per-stage status"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {summary}
      </button>
      {expanded && (
        <div style={{
          marginTop: 6,
          padding: 10,
          background: '#fafafa',
          border: '1px solid #e5e7eb',
          borderRadius: 6,
          fontSize: 12,
          color: '#374151',
          lineHeight: 1.5,
          maxWidth: 720
        }}>
          <div><b>Stage 1 (Perplexity):</b> {parsed.stage1}</div>
          <div><b>Stage 2 (Opus verify):</b> {parsed.stage2}</div>
          <div><b>Stage 3 (Opus strategic):</b> {parsed.stage3}</div>
          {parsed.stage4 !== undefined && (
            <div><b>Stage 4 (Opus fact-check):</b> {parsed.stage4}</div>
          )}
          <div style={{ marginTop: 6, color: '#6b7280' }}>
            Last attempt: {parsed.last_attempt_at}
          </div>
        </div>
      )}
    </div>
  );
}

// v1.10.2 — fact-check report rendering (Stage 4 output).
function FactCheckReportBlock({ report }: { report: FactCheckReport | null }) {
  const [open, setOpen] = useState(false);
  if (!report) return null;

  const confPalette: Record<FactCheckReport['overall_confidence'], { bg: string; fg: string }> = {
    high:   { bg: '#d1fae5', fg: '#065f46' },
    medium: { bg: '#fef3c7', fg: '#92400e' },
    low:    { bg: '#fee2e2', fg: '#991b1b' }
  };
  const conf = confPalette[report.overall_confidence] || confPalette.medium;
  const sectionEntries = Object.entries(report.per_section_verdicts);

  return (
    <div style={{ marginTop: 14, padding: 12, background: '#f0f9ff', borderRadius: 8, border: '1px solid #bae6fd' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', width: '100%', textAlign: 'left' }}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span style={{ fontWeight: 600, fontSize: 13, color: '#075985' }}>
          Fact-check report (Stage 4 — Claude Opus)
        </span>
        <span style={{
          marginLeft: 8,
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          padding: '2px 6px',
          borderRadius: 4,
          background: conf.bg,
          color: conf.fg
        }}>
          {report.overall_confidence} confidence
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6b7280' }}>
          {report.sources_fetched}/{report.sources_attempted} sources verified
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 12, display: 'grid', gap: 14 }}>
          {sectionEntries.length > 0 && (
            <div>
              <div className="label" style={{ marginBottom: 8 }}>Per-section verdicts</div>
              <div style={{ display: 'grid', gap: 8 }}>
                {sectionEntries.map(([name, v]) => (
                  <FactCheckSectionCard key={name} name={name} verdict={v} />
                ))}
              </div>
            </div>
          )}
          {report.flagged_claims && report.flagged_claims.length > 0 && (
            <div>
              <div className="label" style={{ marginBottom: 8 }}>Flagged claims</div>
              <div style={{ display: 'grid', gap: 6 }}>
                {report.flagged_claims.map((c, i) => (
                  <FactCheckClaimRow key={i} claim={c} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
function FactCheckSectionCard({ name, verdict }: { name: string; verdict: FactCheckSectionVerdict }) {
  const palette: Record<FactCheckSectionVerdict['verdict'], { bg: string; fg: string; label: string }> = {
    verified:            { bg: '#d1fae5', fg: '#065f46', label: 'verified' },
    partially_supported: { bg: '#fef3c7', fg: '#92400e', label: 'partially supported' },
    unsupported:         { bg: '#fee2e2', fg: '#991b1b', label: 'unsupported' },
    inconclusive:        { bg: '#f3f4f6', fg: '#4b5563', label: 'inconclusive' }
  };
  const s = palette[verdict.verdict] || palette.inconclusive;
  return (
    <div style={{ padding: 10, background: 'white', borderRadius: 6, border: '1px solid #e0e7ef' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: '#1f2937', textTransform: 'capitalize' }}>
          {name.replace(/_/g, ' ')}
        </span>
        <span style={{
          fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
          padding: '2px 6px', borderRadius: 4, background: s.bg, color: s.fg
        }}>
          {s.label}
        </span>
      </div>
      <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.5, marginBottom: 6 }}>{verdict.reasoning}</div>
      {verdict.supporting_source_urls && verdict.supporting_source_urls.length > 0 && (
        <div style={{ fontSize: 11, color: '#6b7280' }}>
          Supporting sources:{' '}
          {verdict.supporting_source_urls.slice(0, 3).map((u, i) => (
            <span key={i}>
              {i > 0 && ' · '}
              <a onClick={() => openExternal(u)} style={{ cursor: 'pointer', color: '#0369a1', textDecoration: 'underline' }}>
                {(() => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } })()}
              </a>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
function FactCheckClaimRow({ claim }: { claim: FactCheckFlaggedClaim }) {
  const palette: Record<FactCheckFlaggedClaim['status'], { bg: string; fg: string }> = {
    verified:     { bg: '#d1fae5', fg: '#065f46' },
    unsupported:  { bg: '#fef3c7', fg: '#92400e' },
    contradicted: { bg: '#fee2e2', fg: '#991b1b' },
    inconclusive: { bg: '#f3f4f6', fg: '#4b5563' }
  };
  const s = palette[claim.status] || palette.inconclusive;
  return (
    <div style={{ padding: 8, background: 'white', borderRadius: 6, border: '1px solid #e0e7ef', fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{
          fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
          padding: '2px 6px', borderRadius: 4, background: s.bg, color: s.fg
        }}>
          {claim.status}
        </span>
        {claim.source_url && (
          <a onClick={() => openExternal(claim.source_url!)} style={{ cursor: 'pointer', color: '#0369a1', textDecoration: 'underline', fontSize: 11 }}>
            source
          </a>
        )}
      </div>
      <div style={{ color: '#1f2937', marginBottom: 4, fontStyle: 'italic' }}>"{claim.claim}"</div>
      <div style={{ color: '#6b7280' }}>{claim.reason}</div>
    </div>
  );
}

function IcpSegmentCard({ segment }: { segment: IcpSegment }) {
  return (
    <div style={{ padding: 12, background: 'white', border: '1px solid #e0e7ff', borderRadius: 8 }}>
      <div style={{ fontWeight: 600, fontSize: 13, color: '#1f2937', marginBottom: 6 }}>{segment.name}</div>
      <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.5, marginBottom: 8 }}>{segment.description}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, fontSize: 12 }}>
        <div>
          <div className="label" style={{ marginBottom: 2 }}>Decision maker</div>
          <div style={{ color: '#1f2937' }}>{segment.decision_maker}</div>
        </div>
        <div>
          <div className="label" style={{ marginBottom: 2 }}>Cycle length</div>
          <div style={{ color: '#1f2937' }}>{segment.cycle_length}</div>
        </div>
      </div>
      {segment.key_signals && (
        <div style={{ marginTop: 8 }}>
          <div className="label" style={{ marginBottom: 4 }}>Key signals</div>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: '#1f2937', lineHeight: 1.5 }}>{segment.key_signals}</div>
        </div>
      )}
    </div>
  );
}

export function BrandsProducts({ onNavigate }: { onNavigate?: (p: Page) => void }) {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [active, setActive] = useState<Brand | null>(null);
  const [showAddBrand, setShowAddBrand] = useState(false);

  const refresh = async () => {
    const list = await window.lh.brands.list();
    setBrands(list);
    if (list.length && !active) setActive(list[0]);
    else if (active) {
      const cur = list.find((b) => b.id === active.id);
      setActive(cur || list[0] || null);
    }
  };
  useEffect(() => { refresh(); }, []);

  return (
    <div>
      <div style={{ marginTop: 16, marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <div className="h-page">Brands & Products</div>
          <div style={{ color: '#6b7280', fontSize: 14, marginTop: 4 }}>
            Curate the portfolio LeadsHawk hunts opportunities for
          </div>
        </div>
        <button className="btn-primary" onClick={() => setShowAddBrand(true)}>
          <Plus size={14} style={{ display: 'inline', marginRight: 6 }} /> Add Brand
        </button>
      </div>

      <div style={{ display: 'flex', gap: 20 }}>
        <div style={{ width: 240 }} className="card">
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #e5e7eb', fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Brands</div>
          {brands.length === 0 && <div style={{ padding: 16, color: '#6b7280', fontSize: 13 }}>No brands yet. Add one to get started.</div>}
          {brands.map((b) => (
            <button
              key={b.id}
              onClick={() => setActive(b)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '12px 16px', border: 'none', cursor: 'pointer',
                background: active?.id === b.id ? '#f3f4ff' : 'white',
                fontWeight: 500, fontSize: 14
              }}
            >
              {b.name}
            </button>
          ))}
        </div>

        {active ? (
          <div style={{ flex: 1 }}>
            <BrandPanel brand={active} onChanged={refresh} onNavigate={onNavigate} />
          </div>
        ) : (
          <div className="card" style={{ flex: 1, padding: 24, color: '#6b7280' }}>
            Add a brand to begin.
          </div>
        )}
      </div>

      <Modal open={showAddBrand} onClose={() => setShowAddBrand(false)} title="Add Brand">
        <AddBrandForm
          onDone={async (b) => {
            setShowAddBrand(false);
            await refresh();
            setActive(b);
          }}
        />
      </Modal>
    </div>
  );
}

function AddBrandForm({ onDone }: { onDone: (b: Brand) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  return (
    <div>
      <label className="label">Name</label>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Juniper Networks" />
      <div style={{ height: 12 }} />
      <label className="label">Short description</label>
      <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this brand sells, who it sells to" />
      <div style={{ marginTop: 14, textAlign: 'right' }}>
        <button className="btn-primary" disabled={!name || submitting} onClick={async () => {
          setSubmitting(true);
          const b = await window.lh.brands.create({ name, description });
          onDone(b as Brand);
          setSubmitting(false);
        }}>Save Brand</button>
      </div>
    </div>
  );
}

// noteTarget / linkTarget convention:
//   false      → modal closed
//   null       → modal open at brand-level
//   <number>   → modal open at product-level (this product id)
type ModalTarget = false | null | number;

function BrandPanel({ brand, onChanged, onNavigate }: { brand: Brand; onChanged: () => void; onNavigate?: (p: Page) => void }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]);
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [editingBrand, setEditingBrand] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [noteTarget, setNoteTarget] = useState<ModalTarget>(false);
  const [linkTarget, setLinkTarget] = useState<ModalTarget>(false);
  const [busy, setBusy] = useState<string | null>(null);
  // v1.10.0: dossier-feedback modal target. null = closed.
  const [feedbackTarget, setFeedbackTarget] = useState<
    { kind: 'brand' | 'product'; id: number; name: string } | null
  >(null);
  // v1.13.1: Research sources button moved to Live Monitor tab.

  // v1.9.2: signals are now managed in Signal Config. Empty signals on a
  // researched brand or product are surfaced as a banner pointing there.
  const goToSignals = () => onNavigate?.('signals');

  const researchBrand = async () => {
    setBusy('research-brand');
    try { await window.lh.brands.research(brand.id); onChanged(); }
    catch (e: any) { alert(e.message); }
    finally { setBusy(null); }
  };

  const refresh = async () => {
    setProducts(await window.lh.products.list(brand.id));
    setKnowledge(await window.lh.knowledge.list(brand.id));
  };
  useEffect(() => { refresh(); }, [brand.id]);

  const upload = async (productId: number | null) => {
    const key = productId === null ? 'upload' : `upload-${productId}`;
    setBusy(key);
    try { await window.lh.knowledge.upload(brand.id, productId); await refresh(); }
    finally { setBusy(null); }
  };

  const brandKnowledge = knowledge.filter((k) => !k.product_id);
  const knowledgeForProduct = (productId: number) =>
    knowledge.filter((k) => k.product_id === productId);
  const noteProductId = typeof noteTarget === 'number' ? noteTarget : null;
  const linkProductId = typeof linkTarget === 'number' ? linkTarget : null;
  const noteProduct = noteProductId ? products.find((p) => p.id === noteProductId) : null;
  const linkProduct = linkProductId ? products.find((p) => p.id === linkProductId) : null;

  const research = async (productId: number) => {
    setBusy('research-' + productId);
    try { await window.lh.products.research(productId); await refresh(); onChanged(); }
    catch (e: any) { alert(e.message); }
    finally { setBusy(null); }
  };

  // v1.9.2: refreshSignals removed — signal research is now a separate job
  // in Signal Config. The dossier-research button no longer touches signals.

  const deleteBrand = async () => {
    if (!confirm(`Delete brand "${brand.name}" and all its products & knowledge?`)) return;
    await window.lh.brands.delete(brand.id);
    onChanged();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="h-section">{brand.name}</div>
            <div style={{ color: '#6b7280', fontSize: 13, marginTop: 4 }}>{brand.description || 'No description yet.'}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span
              className={`chip ${brand.scan_enabled === 1 ? 'chip-qualified' : 'chip-muted'}`}
              title="Toggle on the Scan Jobs tab → Scan inclusion card."
            >
              {brand.scan_enabled === 1 ? 'scans on' : 'scans paused'}
            </span>
            <RecencyChip brand={brand} />
            <button
              className="btn-ghost"
              onClick={researchBrand}
              disabled={busy === 'research-brand'}
              title="Generate a brand-level dossier — positioning, ICP, market category, brand signals, summary. Used by every scan as foundational context."
            >
              <Sparkles size={13} style={{ display: 'inline', marginRight: 4 }} />
              {busy === 'research-brand'
                ? 'Researching brand…'
                : brand.research_status === 'ready' ? 'Re-research brand' : 'Run brand research'}
            </button>
            {brand.research_status === 'ready' && (
              <button
                className="btn-ghost"
                onClick={() => setFeedbackTarget({ kind: 'brand', id: brand.id, name: brand.name })}
                disabled={busy === 'research-brand'}
                title="Re-research the brand dossier with reviewer feedback injected at every stage."
              >
                <MessageSquare size={13} style={{ display: 'inline', marginRight: 4 }} />
                Re-research with feedback
              </button>
            )}
            {/* v1.13.1: Research sources button moved to Live Monitor → Sources card. */}
            <button className="btn-ghost" onClick={() => setEditingBrand(true)}>
              <Pencil size={13} style={{ display: 'inline', marginRight: 4 }} /> Edit
            </button>
            <button className="btn-danger" onClick={deleteBrand}>Delete</button>
          </div>
        </div>
        {brand.scan_enabled !== 1 && (
          <div style={{ marginTop: 14, padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 13, color: '#991b1b' }}>
            This brand is currently paused — none of its products will be scanned. Toggle it back on under <b>Scan Jobs → Scan inclusion</b>.
          </div>
        )}
        {/* v1.6: brand research status + dossier */}
        <BrandResearchPanel brand={brand} knowledge={knowledge} />
        {/* v1.9.2: brand-level signals are managed separately — flag if empty. */}
        {brand.research_status === 'ready' && !(brand.signals && brand.signals.trim()) && (
          <div style={{ marginTop: 12, padding: '8px 12px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, fontSize: 12, color: '#7c2d12', display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={14} style={{ flexShrink: 0 }} />
            <span>
              Brand-level signals not researched yet.
              {onNavigate && (
                <>
                  {' '}
                  <button
                    onClick={goToSignals}
                    style={{ background: 'transparent', border: 'none', padding: 0, color: '#6c5cf2', textDecoration: 'underline', cursor: 'pointer', fontSize: 12 }}
                  >
                    Go to Signal Config →
                  </button>
                </>
              )}
            </span>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div className="h-section">Products</div>
          <button className="btn-ghost" onClick={() => setShowAddProduct(true)}>
            <Plus size={14} style={{ display: 'inline', marginRight: 4 }} /> Add Product
          </button>
        </div>
        {products.length === 0 && <div style={{ color: '#6b7280', fontSize: 13 }}>No products yet.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {products.map((p) => (
            <div key={p.id} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, background: p.scan_enabled === 1 ? 'white' : '#fafafa' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{p.name}{p.category ? <span style={{ color: '#6b7280', fontWeight: 400 }}> — {p.category}</span> : null}</div>
                  <div style={{ color: '#6b7280', fontSize: 13, marginTop: 4 }}>{p.description || 'No description.'}</div>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  {/* v1.17.1: surface research_status='error' on product
                      cards. Mirrors the brand-level pattern (line ~1031).
                      Pre-v1.17.1 this was completely silent — research
                      could fail mid-pipeline and the user would only
                      notice via missing dossier sections. */}
                  {p.research_status === 'error' && (
                    <span
                      className="chip chip-disqualified"
                      title="The most recent re-research run failed before completing. Expand the dossier section below for details, or check the Stage chip for which stage broke."
                    >
                      research error
                    </span>
                  )}
                  <span
                    className={`chip ${p.scan_enabled === 1 && brand.scan_enabled === 1 ? 'chip-qualified' : 'chip-muted'}`}
                    title="Toggle on the Scan Jobs tab → Scan inclusion card."
                  >
                    {p.scan_enabled === 1 && brand.scan_enabled === 1 ? 'scans on' : 'scans paused'}
                  </span>
                  <RecencyChip product={p} brand={brand} />
                  <button className="btn-ghost" onClick={() => research(p.id)} disabled={busy === 'research-' + p.id}>
                    <Sparkles size={13} style={{ display: 'inline', marginRight: 4 }} />
                    {busy === 'research-' + p.id ? 'Researching…' : (p.research_status === 'ready' ? 'Re-research' : 'Run research')}
                  </button>
                  {p.research_status === 'ready' && (
                    <button
                      className="btn-ghost"
                      onClick={() => setFeedbackTarget({ kind: 'product', id: p.id, name: p.name })}
                      disabled={busy === 'research-' + p.id}
                      title="Re-research this product's dossier with reviewer feedback injected at every stage."
                    >
                      <MessageSquare size={13} style={{ display: 'inline', marginRight: 4 }} />
                      Re-research with feedback
                    </button>
                  )}
                  <button
                    className="btn-ghost"
                    onClick={() => setEditingProduct(p)}
                    title="Edit name, description, and the research dossier"
                  >
                    <Pencil size={13} style={{ display: 'inline', marginRight: 4 }} /> Edit
                  </button>
                  <button className="btn-danger" onClick={async () => {
                    if (confirm(`Delete ${p.name}?`)) { await window.lh.products.delete(p.id); refresh(); }
                  }}><Trash2 size={13} /></button>
                </div>
              </div>
              {p.research_summary && (() => {
                const conf = parseConfidenceLevels(p.confidence_levels);
                const strategic = parseStrategicIntel(p.strategic_intel);
                const factCheck = parseFactCheckReport(p.fact_check_report);
                // v1.17.2: gate labels on the LATEST run's status_detail
                // instead of persistent timestamps. Prevents the "Opus
                // verified + fact-checked" label from lying after a failed
                // re-research overwrites Stage 1 but leaves Stage 2/4
                // timestamps from a previous successful run.
                const labelState = dossierLabelState(
                  p.research_status_detail,
                  p.last_advanced_research_at,
                  p.last_fact_check_at
                );
                return (
                  <details style={{ marginTop: 10 }}>
                    <summary style={{ cursor: 'pointer', color: '#6b7280', fontSize: 12 }}>
                      View research dossier
                      {labelState.verified && (
                        <span style={{ marginLeft: 8, fontSize: 11, color: '#4c1d95' }}>
                          · Opus verified{labelState.factChecked ? ' + fact-checked' : ''}
                        </span>
                      )}
                    </summary>
                    <div style={{ marginTop: 8, fontSize: 13, display: 'grid', gap: 10 }}>
                      {/* v1.10.1: signals removed from dossier — managed in Signal Config. */}
                      {p.use_cases && <Field label="Use cases" value={p.use_cases} confidence={conf?.use_cases} />}
                      {p.competitors && <Field label="Competitors" value={p.competitors} confidence={conf?.competitors} />}
                      {p.differentiators && <Field label="Differentiators" value={p.differentiators} confidence={conf?.differentiators} />}
                      <Field label="Summary" value={p.research_summary} confidence={conf?.research_summary} />
                      <UnknownsBlock unknowns={p.unknowns} />
                      <StrategicIntelBlock intel={strategic} />
                      <FactCheckReportBlock report={factCheck} />
                    </div>
                  </details>
                );
              })()}
              {/* v1.10.1: per-stage status (visible at-a-glance even when dossier is collapsed). */}
              <ResearchStatusChip raw={p.research_status_detail} />
              {/* v1.9.2: signals are managed separately now — flag empty signals here. */}
              {p.research_status === 'ready' && !(p.signals && p.signals.trim()) && (
                <div style={{ marginTop: 10, padding: '8px 12px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, fontSize: 12, color: '#7c2d12', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <AlertTriangle size={14} style={{ flexShrink: 0 }} />
                  <span>
                    Signals not researched yet — scans won't produce leads for this product until you run signal research.
                    {onNavigate && (
                      <>
                        {' '}
                        <button
                          onClick={goToSignals}
                          style={{ background: 'transparent', border: 'none', padding: 0, color: '#6c5cf2', textDecoration: 'underline', cursor: 'pointer', fontSize: 12 }}
                        >
                          Go to Signal Config →
                        </button>
                      </>
                    )}
                  </span>
                </div>
              )}
              <ReResearchBadge
                lastResearchedAt={p.last_researched_at}
                knowledgeItems={knowledgeForProduct(p.id)}
                kind="product"
              />


              {/* Product-level knowledge */}
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed #e5e7eb' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div className="label">Product knowledge</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn-ghost" onClick={() => upload(p.id)} disabled={busy === `upload-${p.id}`}>
                      <FileText size={13} style={{ display: 'inline', marginRight: 4 }} />
                      {busy === `upload-${p.id}` ? 'Uploading…' : 'Upload'}
                    </button>
                    <button className="btn-ghost" onClick={() => setLinkTarget(p.id)}>
                      <Link2 size={13} style={{ display: 'inline', marginRight: 4 }} /> Add Link
                    </button>
                    <button className="btn-ghost" onClick={() => setNoteTarget(p.id)}>
                      <NotebookPen size={13} style={{ display: 'inline', marginRight: 4 }} /> Add Note
                    </button>
                  </div>
                </div>
                {knowledgeForProduct(p.id).length === 0 ? (
                  <div style={{ color: '#9ca3af', fontSize: 12, fontStyle: 'italic' }}>
                    Nothing attached yet — uploads / links / notes added here will be prioritised when running research for this product.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {knowledgeForProduct(p.id).map((k) => (
                      <KnowledgeRow key={k.id} item={k} onDelete={async () => {
                        if (confirm('Remove this item?')) { await window.lh.knowledge.delete(k.id); refresh(); }
                      }} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div className="h-section">Brand-level Knowledge</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn-ghost" onClick={() => upload(null)} disabled={busy === 'upload'}>
              <FileText size={14} style={{ display: 'inline', marginRight: 4 }} />
              {busy === 'upload' ? 'Uploading…' : 'Upload Files'}
            </button>
            <button className="btn-ghost" onClick={() => setLinkTarget(null)}>
              <Link2 size={14} style={{ display: 'inline', marginRight: 4 }} /> Add Link
            </button>
            <button className="btn-ghost" onClick={() => setNoteTarget(null)}>
              <NotebookPen size={14} style={{ display: 'inline', marginRight: 4 }} /> Add Note
            </button>
          </div>
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          Material that applies to the whole brand. For product-specific material, use the “Product knowledge” section inside each product above.
        </div>
        {brandKnowledge.length === 0 ? (
          <div style={{ color: '#6b7280', fontSize: 13 }}>Nothing at brand level. Upload PDFs/PPTs, link sources, or paste notes.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {brandKnowledge.map((k) => (
              <KnowledgeRow key={k.id} item={k} onDelete={async () => {
                if (confirm('Remove this item?')) { await window.lh.knowledge.delete(k.id); refresh(); }
              }} />
            ))}
          </div>
        )}
      </div>

      <Modal open={showAddProduct} onClose={() => setShowAddProduct(false)} title="Add Product">
        <AddProductForm brandId={brand.id} onDone={async () => { setShowAddProduct(false); await refresh(); }} />
      </Modal>
      <Modal open={editingBrand} onClose={() => setEditingBrand(false)} title={`Edit Brand — ${brand.name}`}>
        <EditBrandForm
          brand={brand}
          onDone={async () => { setEditingBrand(false); await refresh(); onChanged(); }}
        />
      </Modal>
      <Modal open={!!editingProduct} onClose={() => setEditingProduct(null)} title={editingProduct ? `Edit Product — ${editingProduct.name}` : ''}>
        {editingProduct && (
          <EditProductForm
            product={editingProduct}
            onDone={async () => { setEditingProduct(null); await refresh(); onChanged(); }}
          />
        )}
      </Modal>
      <Modal
        open={noteTarget !== false}
        onClose={() => setNoteTarget(false)}
        title={noteProduct ? `Add Note — ${noteProduct.name}` : 'Add Brand-level Note'}
      >
        <AddNoteForm
          brandId={brand.id}
          productId={noteProductId}
          productName={noteProduct?.name}
          onDone={async () => { setNoteTarget(false); await refresh(); }}
        />
      </Modal>
      <Modal
        open={linkTarget !== false}
        onClose={() => setLinkTarget(false)}
        title={linkProduct ? `Add Link — ${linkProduct.name}` : 'Add Brand-level Link'}
      >
        <AddLinkForm
          brandId={brand.id}
          productId={linkProductId}
          productName={linkProduct?.name}
          onDone={async () => { setLinkTarget(false); await refresh(); }}
        />
      </Modal>

      {/* v1.10.0: dossier feedback modal for brand + product re-research. */}
      {feedbackTarget && (
        <FeedbackModal
          open={!!feedbackTarget}
          onClose={() => setFeedbackTarget(null)}
          kind={feedbackTarget.kind}
          targetId={feedbackTarget.id}
          targetName={feedbackTarget.name}
          onCompleted={async () => { await refresh(); onChanged(); }}
        />
      )}

      {/* v1.13.1: Research sources modal moved to Live Monitor tab. */}
    </div>
  );
}

function KnowledgeRow({ item, onDelete }: { item: KnowledgeItem; onDelete: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, fontSize: 14 }}>
          {item.kind === 'link' ? (
            <a onClick={() => openExternal(item.source)} style={{ cursor: 'pointer' }}>{item.title}</a>
          ) : item.title}
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          <span className="chip chip-muted" style={{ marginRight: 6 }}>{item.kind}</span>
          {fmtDateShort(item.created_at)} {item.kind === 'link' && '· ' + item.source}
        </div>
      </div>
      <button className="btn-danger" onClick={onDelete}>
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function Field({ label, value, confidence }: { label: string; value: string; confidence?: ConfidenceLevel }) {
  return (
    <div>
      <div className="label" style={{ marginBottom: 4 }}>
        {label}
        <ConfidencePill level={confidence} />
      </div>
      <div style={{ whiteSpace: 'pre-wrap', color: '#1f2937', fontSize: 13 }}>{value}</div>
    </div>
  );
}

function AddProductForm({ brandId, onDone }: { brandId: number; onDone: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  return (
    <div>
      <label className="label">Product name</label>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      <div style={{ height: 12 }} />
      <label className="label">Category</label>
      <input className="input" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. SD-WAN, firewall, observability" />
      <div style={{ height: 12 }} />
      <label className="label">Short description</label>
      <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} />
      <div style={{ marginTop: 14, textAlign: 'right' }}>
        <button className="btn-primary" disabled={!name} onClick={async () => {
          await window.lh.products.create({ brand_id: brandId, name, description, category });
          onDone();
        }}>Save Product</button>
      </div>
    </div>
  );
}

function AddNoteForm({
  brandId, productId, productName, onDone
}: { brandId: number; productId: number | null; productName?: string; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  return (
    <div>
      {productName && (
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
          Attaching to product <b>{productName}</b>. This note will be prioritised when running research for it.
        </div>
      )}
      <label className="label">Title</label>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      <div style={{ height: 12 }} />
      <label className="label">Content</label>
      <textarea className="textarea" value={content} onChange={(e) => setContent(e.target.value)} style={{ minHeight: 200 }} />
      <div style={{ marginTop: 14, textAlign: 'right' }}>
        <button className="btn-primary" disabled={!title || !content} onClick={async () => {
          await window.lh.knowledge.addNote({ brandId, productId, title, content });
          onDone();
        }}>Save Note</button>
      </div>
    </div>
  );
}

/**
 * Compact chip showing the effective scan recency window. Mirrors the
 * resolveScanRecency() backend logic so users can see at a glance which
 * window will be used and where it came from (auto vs override vs global).
 */
function RecencyChip({ brand, product }: { brand: Brand; product?: Product }) {
  // Resolve (product.override → product.auto → brand.override → brand.auto → null)
  // We don't have access to global setting here so we show "global" when
  // nothing else is set.
  type Resolved = { value: string; source: string } | null;
  const r: Resolved = (() => {
    if (product?.scan_recency_override) return { value: product.scan_recency_override, source: 'product override' };
    if (product?.scan_recency_auto)     return { value: product.scan_recency_auto,     source: 'product auto' };
    if (brand.scan_recency_override)    return { value: brand.scan_recency_override,   source: 'brand override' };
    if (brand.scan_recency_auto)        return { value: brand.scan_recency_auto,       source: 'brand auto' };
    return null;
  })();
  if (!r) {
    return (
      <span
        className="chip chip-muted"
        title="No per-brand or per-product recency set. Scans will use the global Settings → Recency window."
      >
        recency: global
      </span>
    );
  }
  const isOverride = r.source.includes('override');
  return (
    <span
      className={`chip ${isOverride ? 'chip-brand' : 'chip-qualified'}`}
      title={`Scan recency window for this ${product ? 'product' : 'brand'}, set by ${r.source}. Edit via the Edit button.`}
    >
      recency: {shortRecency(r.value)} {isOverride ? '(override)' : '(auto)'}
    </span>
  );
}

function shortRecency(r: string): string {
  switch (r) {
    case 'day':   return '24h';
    case 'week':  return '7d';
    case 'month': return '30d';
    case 'year':  return '12mo';
    default: return r;
  }
}

function BrandResearchPanel({ brand, knowledge }: { brand: Brand; knowledge: KnowledgeItem[] }) {
  const statusChip = (() => {
    if (brand.research_status === 'researching') {
      return <span className="chip chip-open">researching…</span>;
    }
    if (brand.research_status === 'error') {
      return <span className="chip chip-disqualified">research error</span>;
    }
    if (brand.research_status === 'ready') {
      return <span className="chip chip-qualified">brand dossier ready</span>;
    }
    return <span className="chip chip-muted">brand not yet researched</span>;
  })();

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        {statusChip}
        <ReResearchBadge
          lastResearchedAt={brand.last_researched_at}
          knowledgeItems={knowledge}
          kind="brand"
        />
      </div>

      {brand.research_status !== 'ready' && (
        <div style={{ fontSize: 13, color: '#6b7280' }}>
          Run brand research to give every scan a foundational understanding of this brand —
          positioning, ideal customer profile, brand-level signals, and a market summary.
          {knowledge.length === 0 ? ' (Upload some brand-level knowledge first for best results.)' : ''}
        </div>
      )}

      {brand.research_status === 'ready' && (() => {
        const conf = parseConfidenceLevels(brand.confidence_levels);
        const strategic = parseStrategicIntel(brand.strategic_intel);
        const factCheck = parseFactCheckReport(brand.fact_check_report);
        // v1.17.2: see dossierLabelState rationale — labels must reflect
        // the LATEST run's status, not stale persistent timestamps.
        const labelState = dossierLabelState(
          brand.research_status_detail,
          brand.last_advanced_research_at,
          brand.last_fact_check_at
        );
        return (
          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: 'pointer', color: '#6b7280', fontSize: 12 }}>
              View brand dossier
              {labelState.verified && (
                <span style={{ marginLeft: 8, fontSize: 11, color: '#4c1d95' }}>
                  · Opus verified{labelState.factChecked ? ' + fact-checked' : ''}
                </span>
              )}
            </summary>
            <div style={{ marginTop: 10, padding: 14, background: '#f3f4ff', borderRadius: 8, fontSize: 13, color: '#1f2937', display: 'grid', gap: 12 }}>
              {/* v1.10.1: brand-level signals removed from dossier — managed in Signal Config. */}
              {brand.category && <Field label="Market category" value={brand.category} confidence={conf?.category} />}
              {brand.positioning && <Field label="Positioning" value={brand.positioning} confidence={conf?.positioning} />}
              {brand.target_icp && <Field label="Target ICP (ideal customer profile)" value={brand.target_icp} confidence={conf?.target_icp} />}
              {brand.competitive_summary && <Field label="Competitive summary" value={brand.competitive_summary} confidence={conf?.competitive_summary} />}
              {brand.research_summary && <Field label="Research summary" value={brand.research_summary} confidence={conf?.research_summary} />}
              <UnknownsBlock unknowns={brand.unknowns} />
              <StrategicIntelBlock intel={strategic} />
              <FactCheckReportBlock report={factCheck} />
            </div>
          </details>
        );
      })()}
      {/* v1.10.1: per-stage status (visible at-a-glance even when dossier is collapsed). */}
      <ResearchStatusChip raw={brand.research_status_detail} />
    </div>
  );
}

/**
 * Shows a yellow "Re-research recommended" badge when knowledge has been
 * added (or modified) since the last research run.
 */
function ReResearchBadge({
  lastResearchedAt, knowledgeItems, kind
}: {
  lastResearchedAt: string | null;
  knowledgeItems: KnowledgeItem[];
  kind: 'brand' | 'product';
}) {
  if (!lastResearchedAt) return null; // never researched — explicit "run research" CTA covers this case
  const lastResearchedMs = new Date(lastResearchedAt + 'Z').getTime();
  const newer = knowledgeItems.filter(
    (k) => new Date(k.created_at + 'Z').getTime() > lastResearchedMs
  ).length;
  if (newer === 0) return null;
  return (
    <span
      title={`${newer} ${kind === 'brand' ? 'brand-level' : 'product'} knowledge item${newer === 1 ? '' : 's'} added since the last research run`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 11, padding: '3px 8px',
        background: '#fef3c7', color: '#92400e', borderRadius: 4
      }}
    >
      <AlertTriangle size={11} />
      Re-research recommended ({newer} new)
    </span>
  );
}

function EditBrandForm({ brand, onDone }: { brand: Brand; onDone: () => void }) {
  const [name, setName] = useState(brand.name);
  const [description, setDescription] = useState(brand.description || '');
  const [positioning, setPositioning] = useState(brand.positioning || '');
  const [competitive, setCompetitive] = useState(brand.competitive_summary || '');
  const [recencyOverride, setRecencyOverride] = useState<string>(brand.scan_recency_override || '');
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <label className="label">Brand name</label>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      <div style={{ height: 12 }} />
      <label className="label">Short description</label>
      <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} />
      <div style={{ height: 12 }} />
      <label className="label">Positioning (optional)</label>
      <textarea className="textarea" value={positioning} onChange={(e) => setPositioning(e.target.value)} placeholder="How this brand positions itself in the market" />
      <div style={{ height: 12 }} />
      <label className="label">Competitive summary (optional)</label>
      <textarea
        className="textarea"
        value={competitive}
        onChange={(e) => setCompetitive(e.target.value)}
        style={{ minHeight: 140 }}
        placeholder="Auto-generated after product research — feel free to refine."
      />
      <div style={{ height: 12 }} />
      <label className="label">Scan recency window</label>
      <select
        className="select"
        value={recencyOverride}
        onChange={(e) => setRecencyOverride(e.target.value)}
      >
        <option value="">
          Auto{brand.scan_recency_auto ? ` (${recencyLabel(brand.scan_recency_auto)} — from brand research)` : ' (uses global setting until brand research runs)'}
        </option>
        <option value="day">Override: Last 24 hours</option>
        <option value="week">Override: Last 7 days</option>
        <option value="month">Override: Last 30 days</option>
        <option value="year">Override: Last 12 months</option>
      </select>
      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
        How far back scans look for buying signals for this brand. "Auto" uses the value brand research recommended (based on the signal type). Override only if you know better than the model. Per-product overrides on each product win over the brand setting.
      </div>
      <div style={{ marginTop: 14, textAlign: 'right' }}>
        <button className="btn-primary" disabled={!name.trim() || busy} onClick={async () => {
          setBusy(true);
          try {
            await window.lh.brands.update(brand.id, {
              name: name.trim(),
              description: description.trim() || null as any,
              positioning: positioning.trim() || null as any,
              competitive_summary: competitive.trim() || null as any,
              scan_recency_override: (recencyOverride || null) as any
            });
            onDone();
          } finally { setBusy(false); }
        }}>{busy ? 'Saving…' : 'Save changes'}</button>
      </div>
    </div>
  );
}

function recencyLabel(r: string): string {
  switch (r) {
    case 'day': return 'Last 24 hours';
    case 'week': return 'Last 7 days';
    case 'month': return 'Last 30 days';
    case 'year': return 'Last 12 months';
    default: return r;
  }
}

function EditProductForm({ product, onDone }: { product: Product; onDone: () => void }) {
  const [name, setName] = useState(product.name);
  const [category, setCategory] = useState(product.category || '');
  const [description, setDescription] = useState(product.description || '');
  const [useCases, setUseCases] = useState(product.use_cases || '');
  const [competitors, setCompetitors] = useState(product.competitors || '');
  const [differentiators, setDifferentiators] = useState(product.differentiators || '');
  const [signals, setSignals] = useState(product.signals || '');
  const [summary, setSummary] = useState(product.research_summary || '');
  const [recencyOverride, setRecencyOverride] = useState<string>(product.scan_recency_override || '');
  const [busy, setBusy] = useState(false);

  // Detect whether signals changed so we re-embed for the live monitor.
  const signalsChanged = (signals || '').trim() !== (product.signals || '').trim();

  return (
    <div style={{ maxHeight: '70vh', overflowY: 'auto', paddingRight: 4 }}>
      <label className="label">Name</label>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      <div style={{ height: 12 }} />
      <label className="label">Category</label>
      <input className="input" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. SD-WAN, firewall, observability" />
      <div style={{ height: 12 }} />
      <label className="label">Short description</label>
      <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} />

      <div style={{ marginTop: 18, padding: '12px 0 0', borderTop: '1px solid #e5e7eb' }}>
        <div className="label" style={{ marginBottom: 4 }}>Research dossier</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          Edit the fields below to refine what scans use. Use markdown bullets (lines starting with <code>-</code>) for the list fields.
        </div>
      </div>

      <label className="label">Use cases</label>
      <textarea className="textarea" value={useCases} onChange={(e) => setUseCases(e.target.value)} style={{ minHeight: 120 }} />
      <div style={{ height: 12 }} />
      <label className="label">Competitors</label>
      <textarea className="textarea" value={competitors} onChange={(e) => setCompetitors(e.target.value)} style={{ minHeight: 100 }} />
      <div style={{ height: 12 }} />
      <label className="label">Differentiators</label>
      <textarea className="textarea" value={differentiators} onChange={(e) => setDifferentiators(e.target.value)} style={{ minHeight: 100 }} />
      <div style={{ height: 12 }} />
      <label className="label">Signals to watch</label>
      <textarea className="textarea" value={signals} onChange={(e) => setSignals(e.target.value)} style={{ minHeight: 140 }} />
      {signalsChanged && (
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
          Signals were changed — embeddings for the Live Monitor will be refreshed when you save.
        </div>
      )}
      <div style={{ height: 12 }} />
      <label className="label">Research summary</label>
      <textarea className="textarea" value={summary} onChange={(e) => setSummary(e.target.value)} style={{ minHeight: 180 }} />

      <div style={{ height: 14 }} />
      <label className="label">Scan recency window</label>
      <select
        className="select"
        value={recencyOverride}
        onChange={(e) => setRecencyOverride(e.target.value)}
      >
        <option value="">
          Auto{product.scan_recency_auto ? ` (${recencyLabel(product.scan_recency_auto)} — from product research)` : ' (falls back to brand setting, then global)'}
        </option>
        <option value="day">Override: Last 24 hours</option>
        <option value="week">Override: Last 7 days</option>
        <option value="month">Override: Last 30 days</option>
        <option value="year">Override: Last 12 months</option>
      </select>
      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
        Per-product wins over the brand setting. Leave on "Auto" to use whatever product research recommended.
      </div>

      <div style={{ marginTop: 16, textAlign: 'right' }}>
        <button className="btn-primary" disabled={!name.trim() || busy} onClick={async () => {
          setBusy(true);
          try {
            await window.lh.products.update(product.id, {
              name: name.trim(),
              category: category.trim(),
              description: description.trim(),
              use_cases: useCases,
              competitors,
              differentiators,
              signals,
              research_summary: summary,
              scan_recency_override: (recencyOverride || null) as any
            });
            // If signals were edited, kick off a fresh embed pass so the
            // Live Monitor's local pre-filter sees the new vectors.
            if (signalsChanged) {
              await window.lh.products.reembed(product.id).catch(() => {});
            }
            onDone();
          } finally { setBusy(false); }
        }}>{busy ? 'Saving…' : 'Save changes'}</button>
      </div>
    </div>
  );
}

function AddLinkForm({
  brandId, productId, productName, onDone
}: { brandId: number; productId: number | null; productName?: string; onDone: () => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      {productName && (
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
          Attaching to product <b>{productName}</b>.
        </div>
      )}
      <label className="label">URL</label>
      <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>LeadsHawk will fetch the page and add it to the knowledge base.</div>
      {error && <div style={{ color: '#b91c1c', marginTop: 8, fontSize: 13 }}>{error}</div>}
      <div style={{ marginTop: 14, textAlign: 'right' }}>
        <button className="btn-primary" disabled={!url || busy} onClick={async () => {
          setBusy(true); setError(null);
          try {
            await window.lh.knowledge.addLink({ brandId, productId, url });
            onDone();
          } catch (e: any) { setError(e.message); }
          finally { setBusy(false); }
        }}>{busy ? 'Fetching…' : 'Add Link'}</button>
      </div>
    </div>
  );
}
