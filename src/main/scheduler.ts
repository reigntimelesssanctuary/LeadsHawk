import cron, { ScheduledTask } from 'node-cron';
import { runDeepScan } from './scanner.js';
import { getSettings } from './settings.js';

// v1.12.0: manual scan retired. Only deep scan is scheduled now.
// runScan() stays available for runDeepScan()'s single-stage fallback path,
// but is no longer triggered by cron or user button. settings.scanCron /
// scanEnabled are deprecated but kept in the type for back-compat reads.

let deepTask: ScheduledTask | null = null;

type RunHook = (info: { ok: boolean; kind: 'deep'; error?: string }) => void;

export function startScheduler(onRun?: RunHook) {
  stopScheduler();
  const settings = getSettings();

  if (settings.deepScanEnabled) {
    if (!cron.validate(settings.deepScanCron)) {
      console.warn('Invalid deep-scan cron, scheduler not started:', settings.deepScanCron);
    } else {
      deepTask = cron.schedule(settings.deepScanCron, async () => {
        try {
          await runDeepScan();
          onRun?.({ ok: true, kind: 'deep' });
        } catch (e: any) {
          onRun?.({ ok: false, kind: 'deep', error: e.message });
        }
      });
    }
  }
}

export function stopScheduler() {
  if (deepTask) { deepTask.stop(); deepTask = null; }
}

export function restartScheduler() {
  startScheduler();
}
