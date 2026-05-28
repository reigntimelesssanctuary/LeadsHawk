import cron, { ScheduledTask } from 'node-cron';
import { runDeepScan } from './scanner.js';
import { getSettings } from './settings.js';

// v1.12.0: manual scan retired. Only deep scan is scheduled now.
// v1.14.0: scanCron / scanEnabled removed from Settings entirely. runScan()
// is now orphaned dead code that no caller invokes (kept temporarily to
// avoid an invasive deletion in this release).

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
