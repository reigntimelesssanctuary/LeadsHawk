/**
 * v1.9.2 — Shared "Re-research with feedback" modal (signal kinds).
 * v1.10.0 — Generalised to all four kinds:
 *             'brand'           → window.lh.brands.research(id, { feedback })
 *             'product'         → window.lh.products.research(id, { feedback })
 *             'brand_signals'   → window.lh.brands.researchSignals(id, { feedback })
 *             'product_signals' → window.lh.products.researchSignals(id, { feedback })
 *
 * The kind/target props determine which feedback history is loaded and
 * which research IPC is called on submit. Same modal shell, different
 * routing — one source of truth for the feedback UX.
 */

import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import type { DossierFeedback, FeedbackTargetKind } from '../../../shared/types';
import { fmtDateShort } from '../lib/api';

const FEEDBACK_MAX = 4000;

export type FeedbackKind = FeedbackTargetKind;

// v1.9.x back-compat alias for any caller still using the old name.
export type SignalFeedbackKind = Extract<FeedbackKind, 'brand_signals' | 'product_signals'>;

const TITLES: Record<FeedbackKind, (name: string) => string> = {
  brand: (name) => `Re-research ${name} (full dossier) with feedback`,
  product: (name) => `Re-research ${name} (full dossier) with feedback`,
  brand_signals: (name) => `Re-research signals for ${name} with feedback`,
  product_signals: (name) => `Re-research signals for ${name} with feedback`
};

const DURATIONS: Record<FeedbackKind, string> = {
  brand: 'Takes a few minutes — full Stage 1 + Stage 2 + Stage 3 re-research with feedback injected at every stage.',
  product: 'Takes a few minutes — full Stage 1 + Stage 2 + Stage 3 re-research with feedback injected at every stage.',
  brand_signals: 'Cheap (~$0.01–0.02), takes a few seconds.',
  product_signals: 'Cheap (~$0.01–0.02), takes a few seconds.'
};

async function dispatch(kind: FeedbackKind, targetId: number, feedback: string): Promise<void> {
  switch (kind) {
    case 'brand':
      await window.lh.brands.research(targetId, { feedback });
      return;
    case 'product':
      await window.lh.products.research(targetId, { feedback });
      return;
    case 'brand_signals':
      await window.lh.brands.researchSignals(targetId, { feedback });
      return;
    case 'product_signals':
      await window.lh.products.researchSignals(targetId, { feedback });
      return;
  }
}

export function FeedbackModal({
  open, onClose, kind, targetId, targetName, onCompleted
}: {
  open: boolean;
  onClose: () => void;
  kind: FeedbackKind;
  targetId: number;
  targetName: string;
  /** Called after a successful re-research run so the parent can refresh. */
  onCompleted: () => void;
}) {
  const [history, setHistory] = useState<DossierFeedback[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!open) return;
    setText('');
    setError(null);
    setBusy(false);
    setExpanded(new Set());
    window.lh.feedback.list(kind, targetId).then(setHistory).catch(() => setHistory([]));
  }, [open, kind, targetId]);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.length > FEEDBACK_MAX) {
      setError(`Feedback is over the ${FEEDBACK_MAX}-char limit.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await dispatch(kind, targetId, trimmed);
      onCompleted();
      onClose();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const toggleEntry = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const charCount = text.length;
  const overCap = charCount > FEEDBACK_MAX;
  const nearCap = charCount > FEEDBACK_MAX * 0.95;

  const title = TITLES[kind](targetName);
  const duration = DURATIONS[kind];

  return (
    <Modal open={open} onClose={onClose} title={title} width={680}>
      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
        Tell the model what to change. Useful for correcting factual errors,
        adding context the AI missed, or steering focus. Prior feedback is
        re-applied automatically on every re-research, so corrections persist
        across iterations.
      </div>

      {history.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="label" style={{ marginBottom: 6 }}>
            Past feedback applied ({history.length})
          </div>
          <div
            style={{
              maxHeight: 180,
              overflowY: 'auto',
              border: '1px solid #e5e7eb',
              borderRadius: 8,
              padding: 8,
              background: '#fafafa'
            }}
          >
            {history.map((f) => {
              const isExpanded = expanded.has(f.id);
              const preview = f.feedback.length > 140 && !isExpanded
                ? f.feedback.slice(0, 140) + '…'
                : f.feedback;
              return (
                <div
                  key={f.id}
                  style={{
                    padding: '8px 10px',
                    borderBottom: '1px dashed #e5e7eb',
                    fontSize: 13
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, fontSize: 12, color: '#6b7280', gap: 8 }}>
                    <span>{fmtDateShort(f.created_at)}</span>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      {f.feedback.length > 140 && (
                        <button
                          onClick={() => toggleEntry(f.id)}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: '#6c5cf2',
                            cursor: 'pointer',
                            fontSize: 12,
                            padding: 0
                          }}
                        >
                          {isExpanded ? 'collapse' : 'show full'}
                        </button>
                      )}
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
                          fontSize: 12,
                          padding: 0
                        }}
                        title="Delete this feedback entry"
                      >
                        delete
                      </button>
                    </div>
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap', color: '#1f2937' }}>{preview}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="label" style={{ marginBottom: 6 }}>New feedback</div>
      <textarea
        className="textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='e.g. "Focus on lease renewals — exec changes are noise for this product."'
        style={{ minHeight: 160, fontSize: 13 }}
      />
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 4,
          fontSize: 12,
          color: overCap ? '#b91c1c' : (nearCap ? '#c2410c' : '#9ca3af')
        }}
      >
        <span>Empty feedback won't submit. {duration}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{charCount} / {FEEDBACK_MAX}</span>
      </div>

      {error && (
        <div style={{ marginTop: 10, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, color: '#991b1b', fontSize: 13 }}>
          {error}
        </div>
      )}

      <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button
          className="btn-primary"
          onClick={submit}
          disabled={busy || !text.trim() || overCap}
        >
          {busy ? 'Re-researching…' : 'Submit and re-research'}
        </button>
      </div>
    </Modal>
  );
}

// v1.9.x back-compat — old import name still works.
export const SignalFeedbackModal = FeedbackModal;
