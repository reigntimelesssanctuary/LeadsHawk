/**
 * v1.13.0 — Auto-research news sources for a brand.
 *
 * Flow:
 *   1. Modal opens for a specific brand
 *   2. Optional feedback textarea (past feedback shown above if present)
 *   3. User clicks "Research sources" → Perplexity researches, returns suggestions
 *   4. User reviews + checks which suggestions to add
 *   5. Click "Add N selected sources" → persists via monitor_sources insert
 *   6. Modal closes with success toast
 */

import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Globe, Newspaper, AlertCircle, Sparkles } from 'lucide-react';
import type { DossierFeedback, SourceSuggestion } from '../../../shared/types';
import { fmtDateShort, openExternal } from '../lib/api';

const FEEDBACK_MAX = 4000;

type Phase = 'idle' | 'researching' | 'review' | 'adding' | 'done';
type TrialPeriod = '24h' | '48h' | '7d' | 'permanent';

export function ResearchSourcesModal({
  open, onClose, brandId, brandName, onCompleted
}: {
  open: boolean;
  onClose: () => void;
  brandId: number;
  brandName: string;
  /** Called after sources are added so the parent can refresh. */
  onCompleted: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [history, setHistory] = useState<DossierFeedback[]>([]);
  const [feedback, setFeedback] = useState('');
  const [suggestions, setSuggestions] = useState<SourceSuggestion[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [addedCount, setAddedCount] = useState(0);
  const [mergedCount, setMergedCount] = useState(0);
  // v1.13.1: trial period for the add. Default 24h — sources auto-disable
  // after the trial unless promoted via Live Monitor → Sources.
  const [trialPeriod, setTrialPeriod] = useState<TrialPeriod>('24h');

  useEffect(() => {
    if (!open) return;
    setFeedback('');
    setSuggestions([]);
    setSelectedIdx(new Set());
    setError(null);
    setAddedCount(0);
    setMergedCount(0);
    setTrialPeriod('24h');
    window.lh.feedback.list('brand_sources', brandId).then(setHistory).catch(() => setHistory([]));

    // v1.13.2: check for pending (unreviewed) suggestions from a previous
    // research run that was closed mid-flight. If present, jump straight
    // to review phase with those suggestions loaded — no new Perplexity
    // call needed.
    setPhase('idle');
    window.lh.brands.pendingSources(brandId).then((pending) => {
      if (pending && Array.isArray(pending.suggestions) && pending.suggestions.length > 0) {
        setSuggestions(pending.suggestions);
        setSelectedIdx(new Set(pending.suggestions.map((_: any, i: number) => i)));
        setPhase('review');
      }
    }).catch(() => { /* ignore */ });
  }, [open, brandId]);

  const research = async () => {
    const trimmed = feedback.trim();
    if (trimmed.length > FEEDBACK_MAX) {
      setError(`Feedback over ${FEEDBACK_MAX}-char limit.`);
      return;
    }
    setError(null);
    setPhase('researching');
    try {
      const result = await window.lh.brands.researchSources(brandId, trimmed ? { feedback: trimmed } : undefined);
      const items: SourceSuggestion[] = result?.suggestions || [];
      setSuggestions(items);
      // Default-check all suggestions.
      setSelectedIdx(new Set(items.map((_, i) => i)));
      setPhase(items.length === 0 ? 'done' : 'review');
      if (items.length === 0) setError('No suggestions returned. Try adding feedback and retrying.');
    } catch (e: any) {
      setError(String(e?.message || e));
      setPhase('idle');
    }
  };

  const addSelected = async () => {
    const picked = [...selectedIdx].map((i) => suggestions[i]).filter(Boolean);
    if (picked.length === 0) return;
    setPhase('adding');
    setError(null);
    try {
      const result = await window.lh.brands.addSuggestedSources(
        brandId,
        picked,
        { trialPeriod }
      );
      // Backend now returns { added: number[], merged: number[], trialUntil }
      const addedIds = Array.isArray(result) ? result : (result?.added || []);
      const mergedIds = Array.isArray(result) ? [] : (result?.merged || []);
      setAddedCount(addedIds.length);
      setMergedCount(mergedIds.length);
      setPhase('done');
      onCompleted();
      setTimeout(onClose, 2200);
    } catch (e: any) {
      setError(String(e?.message || e));
      setPhase('review');
    }
  };

  const toggleAll = (check: boolean) => {
    if (check) setSelectedIdx(new Set(suggestions.map((_, i) => i)));
    else setSelectedIdx(new Set());
  };
  const toggleOne = (idx: number) => {
    setSelectedIdx((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const overCap = feedback.length > FEEDBACK_MAX;
  const charPct = feedback.length / FEEDBACK_MAX;
  const nearCap = charPct > 0.95;

  return (
    <Modal open={open} onClose={onClose} title={`Research sources for ${brandName}`} width={760}>
      {phase === 'idle' && (
        <>
          <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
            LeadsHawk will use Perplexity with live web access to suggest news sources
            (RSS feeds + Google News queries) that match this brand's signals and ICP.
            Takes 1–3 minutes. You'll review the suggestions before any get added.
            Closing the modal mid-research is safe — suggestions are saved and re-loaded next time you open this modal.
          </div>

          {history.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div className="label" style={{ marginBottom: 6 }}>Past feedback ({history.length})</div>
              <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, padding: 8, background: '#fafafa', fontSize: 12 }}>
                {history.slice(0, 8).map((f) => (
                  <div key={f.id} style={{ padding: '6px 4px', borderBottom: '1px dashed #e5e7eb' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                      <span style={{ color: '#6b7280' }}>{fmtDateShort(f.created_at)}</span>
                      {/* v1.13.5: per-entry delete so stale feedback can be pruned. */}
                      <button
                        onClick={async () => {
                          if (!confirm('Delete this feedback entry? It will stop being re-applied on future re-research runs.')) return;
                          try {
                            await window.lh.feedback.delete(f.id);
                            setHistory((prev) => prev.filter((h) => h.id !== f.id));
                          } catch (e: any) {
                            setError(String(e?.message || e));
                          }
                        }}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#b91c1c',
                          cursor: 'pointer',
                          fontSize: 11,
                          padding: 0
                        }}
                        title="Delete this feedback entry"
                      >
                        delete
                      </button>
                    </div>
                    <div style={{ color: '#1f2937', whiteSpace: 'pre-wrap' }}>{f.feedback.slice(0, 200)}{f.feedback.length > 200 ? '…' : ''}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="label" style={{ marginBottom: 6 }}>Optional feedback for this run</div>
          <textarea
            className="textarea"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder='e.g. "Focus on banking IT publications and avoid generic tech press."'
            style={{ minHeight: 90, fontSize: 13 }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 12, color: overCap ? '#b91c1c' : (nearCap ? '#c2410c' : '#9ca3af') }}>
            <span>Feedback is injected into the prompt and persisted for future runs.</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{feedback.length} / {FEEDBACK_MAX}</span>
          </div>

          {error && (
            <div style={{ marginTop: 10, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, color: '#991b1b', fontSize: 13 }}>{error}</div>
          )}

          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn-primary" onClick={research} disabled={overCap}>
              <Sparkles size={13} style={{ display: 'inline', marginRight: 6, verticalAlign: '-2px' }} />
              Research sources
            </button>
          </div>
        </>
      )}

      {phase === 'researching' && (
        <div style={{ padding: '40px 20px', textAlign: 'center', color: '#6b7280' }}>
          <div style={{ fontSize: 14, marginBottom: 8 }}>Researching relevant sources for <b>{brandName}</b>…</div>
          <div style={{ fontSize: 12, marginBottom: 12 }}>Takes 1–3 minutes. Perplexity is searching the web for industry-specific publications and crafting Google News queries.</div>
          <div style={{ fontSize: 11, color: '#6c5cf2' }}>You can safely close this window — suggestions are saved and will appear when you open Research sources again for {brandName}.</div>
        </div>
      )}

      {phase === 'review' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontSize: 13, color: '#6b7280' }}>
              {suggestions.length} suggestions · {selectedIdx.size} selected
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-ghost" onClick={() => toggleAll(true)} style={{ fontSize: 12 }}>Select all</button>
              <button className="btn-ghost" onClick={() => toggleAll(false)} style={{ fontSize: 12 }}>Clear</button>
            </div>
          </div>

          <div style={{ maxHeight: '50vh', overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
            {suggestions.map((s, i) => (
              <div
                key={i}
                onClick={() => toggleOne(i)}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  padding: '10px 12px',
                  borderBottom: i < suggestions.length - 1 ? '1px solid #f3f4f6' : 'none',
                  cursor: 'pointer',
                  background: selectedIdx.has(i) ? '#f3f4ff' : 'white'
                }}
              >
                <input
                  type="checkbox"
                  checked={selectedIdx.has(i)}
                  onChange={() => toggleOne(i)}
                  onClick={(e) => e.stopPropagation()}
                  style={{ marginTop: 4 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    {s.kind === 'rss' ? (
                      <Newspaper size={13} style={{ color: '#0891b2' }} />
                    ) : (
                      <Globe size={13} style={{ color: '#6c5cf2' }} />
                    )}
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</span>
                    <span className={`chip ${s.kind === 'rss' ? 'chip-qualified' : 'chip-brand'}`} style={{ fontSize: 10, padding: '1px 6px' }}>
                      {s.kind === 'rss' ? 'RSS' : 'Google News'}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: '#1f2937', marginBottom: 4, lineHeight: 1.5 }}>{s.why_relevant}</div>
                  <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>
                    {s.kind === 'rss' && s.url ? (
                      <a onClick={(e) => { e.stopPropagation(); openExternal(s.url!); }} style={{ cursor: 'pointer', color: '#0369a1', textDecoration: 'underline' }}>
                        {s.url}
                      </a>
                    ) : (
                      <>query: <code>{s.query}</code></>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {error && (
            <div style={{ marginTop: 10, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, color: '#991b1b', fontSize: 13 }}>{error}</div>
          )}

          <div style={{ marginTop: 14, padding: 12, background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
            <div className="label" style={{ marginBottom: 6 }}>Trial period</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              {([
                ['24h', '24-hour trial'],
                ['48h', '48-hour trial'],
                ['7d', '7-day trial'],
                ['permanent', 'Permanent (no trial)']
              ] as Array<[TrialPeriod, string]>).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTrialPeriod(key)}
                  style={{
                    fontSize: 12,
                    padding: '4px 10px',
                    borderRadius: 999,
                    cursor: 'pointer',
                    border: trialPeriod === key ? '1px solid #6c5cf2' : '1px solid #e5e7eb',
                    background: trialPeriod === key ? '#ede9fe' : 'white',
                    color: trialPeriod === key ? '#4c1d95' : '#374151',
                    fontWeight: trialPeriod === key ? 600 : 400
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: '#6b7280' }}>
              Trial sources auto-disable when the period expires. You can promote or extend them on Live Monitor → Sources.
            </div>
          </div>

          <div style={{ marginTop: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button className="btn-ghost" onClick={() => setPhase('idle')}>← Back to feedback</button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn-primary" onClick={addSelected} disabled={selectedIdx.size === 0}>
                Add {selectedIdx.size} source{selectedIdx.size === 1 ? '' : 's'}
                {trialPeriod !== 'permanent' ? ` (${trialPeriod} trial)` : ' (permanent)'}
              </button>
            </div>
          </div>
        </>
      )}

      {phase === 'adding' && (
        <div style={{ padding: '40px 20px', textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
          Adding {selectedIdx.size} source{selectedIdx.size === 1 ? '' : 's'} to Live Monitor…
        </div>
      )}

      {phase === 'done' && (
        <div style={{ padding: '40px 20px', textAlign: 'center' }}>
          {(addedCount > 0 || mergedCount > 0) ? (
            <>
              <div style={{ fontSize: 32, marginBottom: 12 }}>✓</div>
              {addedCount > 0 && (
                <div style={{ fontSize: 14, color: '#065f46', marginBottom: 4 }}>
                  {addedCount} new source{addedCount === 1 ? '' : 's'} added
                  {trialPeriod !== 'permanent' ? ` as ${trialPeriod} trial` : ' permanently'}.
                </div>
              )}
              {mergedCount > 0 && (
                <div style={{ fontSize: 13, color: '#4c1d95', marginBottom: 4 }}>
                  {mergedCount} existing source{mergedCount === 1 ? '' : 's'} now also tagged for {brandName}.
                </div>
              )}
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
                New sources start ingesting at their next poll cycle (within 15 minutes).
              </div>
            </>
          ) : (
            <>
              <AlertCircle size={32} style={{ color: '#c2410c', marginBottom: 12 }} />
              <div style={{ fontSize: 14, color: '#7c2d12' }}>{error || 'No sources added.'}</div>
              <button className="btn-ghost" onClick={onClose} style={{ marginTop: 12 }}>Close</button>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
