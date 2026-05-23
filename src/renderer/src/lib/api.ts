export const api = () => window.lh;
export const openExternal = (url: string) => window.lh.openExternal(url);

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  } catch {
    return iso;
  }
}

export function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  } catch {
    return iso;
  }
}

/**
 * SQLite's `datetime('now')` returns a UTC string without a TZ marker
 * (e.g. "2026-05-23 09:38:17"). JS Date parses that as local time, which
 * is wrong. This helper appends 'Z' so the string is treated as UTC.
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
 * Format a timestamp in Singapore time (UTC+8) with AM/PM. Used for the
 * Live Monitor "Fetched" column.
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
