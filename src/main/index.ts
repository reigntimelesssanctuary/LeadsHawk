import { app, BrowserWindow, shell } from 'electron';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { registerIpc, seedDefaults } from './ipc.js';
import { startScheduler } from './scheduler.js';
import { startMonitor, stopMonitor } from './monitor/index.js';
import { getSettings } from './settings.js';
import { getDb } from './db.js';
import { backfillKnowledgeIndex } from './knowledge-index.js';
import { backfillCreatedEvents } from './events.js';
import { recomputeAllLearningSignals } from './learning-signals.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1c1d28',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  });

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  getDb();
  registerIpc();
  seedDefaults();
  // v1.16.0: synthesize 'created' lifecycle events for any pre-existing
  // opportunities so historical data shows up in the new pipeline
  // widgets immediately on install. Sync + idempotent: no-op after the
  // first run since each opportunity gains exactly one 'created' event.
  try {
    const n = backfillCreatedEvents();
    if (n > 0) console.log(`[v1.16] backfilled ${n} created events`);
  } catch (e: any) {
    console.warn('[v1.16] created-event backfill failed:', e?.message || e);
  }
  // v1.17.0: rebuild the learning_signals table at startup so any closed
  // outcomes that landed between sessions are reflected immediately.
  // Idempotent — wipes + repopulates from the event log + state cache.
  try {
    const n = recomputeAllLearningSignals();
    console.log(`[v1.17] learning_signals rebuilt: ${n} dimension/value rows`);
  } catch (e: any) {
    console.warn('[v1.17] learning rebuild failed:', e?.message || e);
  }
  startScheduler();
  // Resume live monitor if the user had it on
  if (getSettings().liveMonitoringEnabled) {
    startMonitor().catch((e) => console.warn('monitor autostart failed:', e?.message || e));
  }
  // v1.6: background-embed any knowledge items uploaded before this version.
  // Don't await — the embedder model loads lazily and the user shouldn't wait.
  setTimeout(() => {
    backfillKnowledgeIndex((m) => console.log(m)).catch((e) =>
      console.warn('knowledge backfill failed:', e?.message || e)
    );
  }, 5_000);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // On macOS, keep running in the background so the monitor stays alive
  // even when the user closes the window. They can fully quit via the menu.
  if (process.platform !== 'darwin') {
    stopMonitor();
    app.quit();
  }
});

app.on('before-quit', () => {
  stopMonitor();
});
