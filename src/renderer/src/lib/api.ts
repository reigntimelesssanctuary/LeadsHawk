export const api = () => window.lh;
export const openExternal = (url: string) => window.lh.openExternal(url);

/**
 * SQLite's `datetime('now')` returns a UTC string without a TZ marker
 * (e.g. "2026-05-23 09:38:17"). JS Date parses that as local time, which
 * is wrong. This helper appends 'Z' so the string is treated as UTC.
 *
 * v1.7.7: hoisted above formatters so they can use it (was below before,
 * which is why fmtDate was rendering UTC strings as local time).
 */
function parseSqliteUtc(iso: string): Date {
  if (!iso) return new Date(NaN);
  // ISO-8601 with explicit TZ marker → trust it
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) return new Date(iso);
  // "YYYY-MM-DD HH:MM:SS" → treat as UTC
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(iso)) {
    return new Date(iso.replace(' ', 'T') + 'Z');
  }
  return new Date(iso);
}

/**
 * Format a timestamp as date + time in Singapore time (UTC+8).
 * v1.7.7: used to render in the system locale + no TZ-aware parsing, which
 * made SQLite-origin timestamps look wrong. Now uniformly SGT.
 */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = parseSqliteUtc(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-SG', {
      timeZone: 'Asia/Singapore',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  } catch {
    return iso;
  }
}

/**
 * Format a timestamp as date-only in Singapore time (UTC+8).
 */
export function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = parseSqliteUtc(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-SG', {
      timeZone: 'Asia/Singapore',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  } catch {
    return iso;
  }
}

/**
 * Format a timestamp in Singapore time with explicit AM/PM. Used for the
 * Live Monitor "Fetched" column where the AM/PM cue matters for "did this
 * arrive overnight or this morning".
 */
export function fmtDateSGT(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = parseSqliteUtc(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-SG', {
      timeZone: 'Asia/Singapore',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  } catch {
    return iso;
  }
}
