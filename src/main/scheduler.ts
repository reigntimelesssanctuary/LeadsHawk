import cron, { ScheduledTask } from 'node-cron';
import { runScan } from './scanner.js';
import { getSettings } from './settings.js';

let task: ScheduledTask | null = null;

export function startScheduler(onRun?: (info: { ok: boolean; error?: string }) => void) {
  stopScheduler();
  const { scanCron, scanEnabled } = getSettings();
  if (!scanEnabled) return;
  if (!cron.validate(scanCron)) {
    console.warn('Invalid scan cron, scheduler not started:', scanCron);
    return;
  }
  task = cron.schedule(scanCron, async () => {
    try {
      await runScan();
      onRun?.({ ok: true });
    } catch (e: any) {
      onRun?.({ ok: false, error: e.message });
    }
  });
}

export function stopScheduler() {
  if (task) {
    task.stop();
    task = null;
  }
}

export function restartScheduler() {
  startScheduler();
}
