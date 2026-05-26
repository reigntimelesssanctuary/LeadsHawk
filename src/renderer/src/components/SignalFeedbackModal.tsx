/**
 * v1.9.2 — Shared "Re-research signals with feedback" modal.
 *
 * Used by Signal Config for both brand-level and product-level signal
 * re-research. The kind/target props determine which feedback history
 * is loaded and which research handler is called on submit.
 */

import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import type { DossierFeedback } from '../../../shared/types';
import { fmtDateShort } from '../lib/api';

const FEEDBACK_MAX = 4000;

export type SignalFeedbackKind = 'brand_signals' | 'product_signals';

export function SignalFeedbackModal({
  open, onClose, kind, targetId, targetName, onCompleted
}: {
  open: boolean;
  onClose: () => void;
  kind: SignalFeedbackKind;
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
      if (kind === 'brand_signals') {
        await window.lh.brands.researchSignals(targetId, { feedback: trimmed });
      } else {
        await window.lh.products.researchSignals(targetId, { feedback: trimmed });
      }
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Re-research signals for ${targetName} with feedback`}
      width={680}
    >
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
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12, color: '#6b7280' }}>
                    <span>{fmtDateShort(f.created_at)}</span>
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
        <span>
          Empty feedback won't submit. Re-research is cheap (~$0.01–0.02).
        </span>
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
