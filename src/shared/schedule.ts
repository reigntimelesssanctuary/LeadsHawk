/**
 * v1.14.0 — cron-free scheduler.
 *
 * The Scan card in Settings used to require typing a cron expression. The
 * user is a non-coder, so we replaced the input with a frequency picker
 * (Daily / Twice daily / Every 6 hours / Every 12 hours / Weekly) plus a
 * contextual time selector. These helpers translate between that picker
 * state and the cron string still persisted in `settings.deepScanCron`
 * (so the scheduler module needs no changes).
 *
 * `cronToSchedule` is forgiving: if it can't recognize the cron pattern
 * it returns a sensible default ({ daily, 9am }) rather than throwing,
 * since the only way an unrecognized cron could land in settings is via
 * dev tooling or a future feature.
 *
 * Both functions are PURE and have inlined copies in
 * `scripts/smoke-perplexity.mjs`. Update both sides when changing
 * behavior.
 */

export type FreqType = 'daily' | 'twice' | 'every6' | 'every12' | 'weekly';

export type Schedule = {
  freq: FreqType;
  /** Hour(s) of day, 0-23. Length depends on freq:
   *   daily   → [h]
   *   twice   → [h1, h2]
   *   weekly  → [h]
   *   every6  → ignored (cron fires at 0/6/12/18)
   *   every12 → ignored (cron fires at 0/12)
   */
  hours: number[];
  /** Day of week 0 (Sun) - 6 (Sat). Only meaningful when freq === 'weekly'. */
  dayOfWeek: number;
};

export const DEFAULT_SCHEDULE: Schedule = { freq: 'twice', hours: [9, 21], dayOfWeek: 1 };

export function scheduleToCron(s: Schedule): string {
  switch (s.freq) {
    case 'daily': {
      const h = clampHour(s.hours[0] ?? 9);
      return `0 ${h} * * *`;
    }
    case 'twice': {
      const h1 = clampHour(s.hours[0] ?? 9);
      const h2 = clampHour(s.hours[1] ?? 21);
      return `0 ${h1},${h2} * * *`;
    }
    case 'every6':
      return '0 */6 * * *';
    case 'every12':
      return '0 */12 * * *';
    case 'weekly': {
      const h = clampHour(s.hours[0] ?? 9);
      const d = clampDow(s.dayOfWeek);
      return `0 ${h} * * ${d}`;
    }
  }
}

export function cronToSchedule(cron: string): Schedule {
  if (!cron || typeof cron !== 'string') return { ...DEFAULT_SCHEDULE };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { ...DEFAULT_SCHEDULE };
  const [min, hour, dom, month, dow] = parts;
  if (min !== '0' || dom !== '*' || month !== '*') return { ...DEFAULT_SCHEDULE };

  // Every 6 hours
  if (hour === '*/6' && dow === '*') {
    return { freq: 'every6', hours: [], dayOfWeek: 1 };
  }
  // Every 12 hours
  if (hour === '*/12' && dow === '*') {
    return { freq: 'every12', hours: [], dayOfWeek: 1 };
  }
  // Weekly — single hour, single dow
  if (dow !== '*' && /^\d+$/.test(hour) && /^\d+$/.test(dow)) {
    const h = Number(hour);
    const d = Number(dow);
    if (h >= 0 && h <= 23 && d >= 0 && d <= 6) {
      return { freq: 'weekly', hours: [h], dayOfWeek: d };
    }
  }
  // Twice daily — two comma-separated hours
  if (dow === '*' && /^\d+,\d+$/.test(hour)) {
    const [h1, h2] = hour.split(',').map(Number);
    if ([h1, h2].every((h) => Number.isFinite(h) && h >= 0 && h <= 23)) {
      return { freq: 'twice', hours: [h1, h2], dayOfWeek: 1 };
    }
  }
  // Daily — single hour
  if (dow === '*' && /^\d+$/.test(hour)) {
    const h = Number(hour);
    if (h >= 0 && h <= 23) {
      return { freq: 'daily', hours: [h], dayOfWeek: 1 };
    }
  }
  return { ...DEFAULT_SCHEDULE };
}

function clampHour(h: number): number {
  if (!Number.isFinite(h)) return 9;
  return Math.max(0, Math.min(23, Math.round(h)));
}

function clampDow(d: number): number {
  if (!Number.isFinite(d)) return 1;
  return Math.max(0, Math.min(6, Math.round(d)));
}

/** Human-readable label used in the Settings caption. */
export function describeSchedule(s: Schedule): string {
  switch (s.freq) {
    case 'daily':
      return `Daily at ${fmtHour(s.hours[0] ?? 9)}`;
    case 'twice':
      return `Twice daily — ${fmtHour(s.hours[0] ?? 9)} and ${fmtHour(s.hours[1] ?? 21)}`;
    case 'every6':
      return 'Every 6 hours — 12 AM, 6 AM, 12 PM, 6 PM';
    case 'every12':
      return 'Every 12 hours — 12 AM and 12 PM';
    case 'weekly':
      return `Weekly — ${dayName(s.dayOfWeek)} at ${fmtHour(s.hours[0] ?? 9)}`;
  }
}

export function fmtHour(h: number): string {
  const x = clampHour(h);
  if (x === 0) return '12 AM';
  if (x === 12) return '12 PM';
  if (x < 12) return `${x} AM`;
  return `${x - 12} PM`;
}

export function dayName(d: number): string {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return names[clampDow(d)] || 'Monday';
}
