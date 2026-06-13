import { app, BrowserWindow, shell, screen, Menu } from 'electron';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { registerIpc, seedDefaults } from './ipc.js';
import { startScheduler } from './scheduler.js';
import { startMonitor, stopMonitor } from './monitor/index.js';
import { startBridge, stopBridge } from './bridge.js';
import { getSettings } from './settings.js';
import { getDb } from './db.js';
import { backfillKnowledgeIndex } from './knowledge-index.js';
import { backfillCreatedEvents } from './events.js';
import { recomputeAllLearningSignals } from './learning-signals.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// v1.17.3: small-screen friendly defaults.
// Preferred opening size — generous on a modern display, but capped at the
// actual screen work area on startup so the window never opens larger than
// what fits. Min sizes lowered drastically (1100→700, 720→480) so the user
// can shrink the window to fit any portable display, and so the OS doesn't
// refuse to resize when the screen itself is smaller than the previous
// 1100/720 floor.
const PREFERRED_WIDTH = 1440;
const PREFERRED_HEIGHT = 900;
const MIN_WIDTH = 700;
const MIN_HEIGHT = 480;

function computeFittedSize() {
  // screen.getPrimaryDisplay().workAreaSize excludes the macOS menu bar and
  // Dock, so it's the actual usable area. We cap our preferred size to
  // (workArea - small margin) so the window has breathing room from the
  // screen edges even on tiny portable displays.
  try {
    const wa = screen.getPrimaryDisplay().workAreaSize;
    const margin = 40;
    return {
      width: Math.max(MIN_WIDTH, Math.min(PREFERRED_WIDTH, wa.width - margin)),
      height: Math.max(MIN_HEIGHT, Math.min(PREFERRED_HEIGHT, wa.height - margin))
    };
  } catch {
    // Defensive: if screen isn't ready yet (shouldn't happen post-whenReady).
    return { width: PREFERRED_WIDTH, height: PREFERRED_HEIGHT };
  }
}

function createWindow() {
  const fitted = computeFittedSize();
  const win = new BrowserWindow({
    width: fitted.width,
    height: fitted.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
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

// v1.17.3: Application menu with explicit View → Zoom items.
//
// Without a defined menu, Electron's default menu provides zoom shortcuts on
// some platforms but they aren't always reliable in packaged production
// builds. Defining our own menu guarantees Cmd+Plus / Cmd+Minus / Cmd+0
// work for zoom, AND surfaces them as discoverable menu items so users on
// small screens know how to fit more content into view.
//
// Also includes the standard Edit menu (cut/copy/paste/select-all) which
// Electron does NOT enable by default on text inputs in production builds
// without an explicit menu — a separate frustration users hit on
// password / API key fields.
function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const }
      ]
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const, label: 'Actual Size' },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const },
              { type: 'separator' as const },
              { role: 'window' as const }
            ]
          : [{ role: 'close' as const }])
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // v1.17.3: install the application menu first so zoom + edit shortcuts
  // are available before the first window opens.
  buildAppMenu();
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
  // Read-only HTTP bridge for external agents (Hermes BDM Step 0). Bound to
  // 127.0.0.1:8772 — see src/main/bridge.ts for the endpoint contract.
  try {
    startBridge();
  } catch (e: any) {
    console.warn('bridge start failed:', e?.message || e);
  }
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
  stopBridge();
});
