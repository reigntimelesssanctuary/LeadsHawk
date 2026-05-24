import cron, { ScheduledTask } from 'node-cron';
import { runScan, runDeepScan } from './scanner.js';
import { getSettings } from './settings.js';

let regularTask: ScheduledTask | null = null;
let deepTask: ScheduledTask | null = null;

type RunHook = (info: { ok: boolean; kind: 'manual' | 'deep'; error?: string }) => void;

export function startScheduler(onRun?: RunHook) {
  stopScheduler();
  const settings = getSettings();

  if (settings.scanEnabled) {
    if (!cron.validate(settings.scanCron)) {
      console.warn('Invalid scan cron, regular scheduler not started:', settings.scanCron);
    } else {
      regularTask = cron.schedule(settings.scanCron, async () => {
        try {
          await runScan();
          onRun?.({ ok: true, kind: 'manual' });
        } catch (e: any) {
          onRun?.({ ok: false, kind: 'manual', error: e.message });
        }
      });
    }
  }

  if (settings.deepScanEnabled) {
    if (!cron.validate(settings.deepScanCron)) {
      console.warn('Invalid deep-scan cron, deep scheduler not started:', settings.deepScanCron);
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
  if (regularTask) { regularTask.stop(); regularTask = null; }
  if (deepTask)    { deepTask.stop();    deepTask = null; }
}

export function restartScheduler() {
  startScheduler();
}
