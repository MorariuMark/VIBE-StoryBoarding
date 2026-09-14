/**
 * HandScribe desktop shell (Electron main process, CommonJS).
 *
 * What it does:
 *  1. Starts the project-local Audio8 GPU sidecar (server/python/.venv python)
 *     and keeps it alive for the whole desktop session — this is the whole
 *     class of "server not reachable / failed to fetch" problems gone: the
 *     app owns the server process, restarts it if it crashes, and only shows
 *     the UI once /health answers.
 *  2. Serves the built frontend (dist/) over http://127.0.0.1:<ephemeral> so
 *     module workers, WASM and WebGPU behave exactly like the web version
 *     (file:// would break all three — hence the embedded static server).
 *  3. Dev mode (npm run electron:dev): loads the vite dev server instead so
 *     HMR keeps working, sidecar management stays identical.
 *
 * Env overrides (mostly for testing):
 *  HANDSCRIBE_ROOT  project root (default: auto-detected)
 *  AUDIO8_PORT      sidecar port (default 8010)
 *  VITE_DEV_URL     dev-server URL in dev mode (default http://localhost:5173)
 */
const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { health, portBusy, serveDist } = require('./lib.cjs');

// Run Chromium (canvas raster + WebCodecs encode) on the discrete GPU.
// Without this Windows parks Electron on the power-saving iGPU and the
// NVIDIA card idles at 0% while exports crawl. Must precede app.ready.
app.commandLine.appendSwitch('force_high_performance_gpu');

const isDev = process.argv.includes('--dev');
const AUDIO8_PORT = Number(process.env.AUDIO8_PORT || 8010);
const DEV_URL = process.env.VITE_DEV_URL || 'http://localhost:5173';

function projectRoot() {
  if (process.env.HANDSCRIBE_ROOT) return process.env.HANDSCRIBE_ROOT;
  if (app.isPackaged) {
    // Packaged: electron-builder nests all files under resources/app/,
    // preserving the project layout (electron/, server/, dist/, ...).
    return path.join(process.resourcesPath, 'app');
  }
  return path.join(__dirname, '..');
}

function venvPython(root) {
  if (process.platform === 'win32') {
    return path.join(root, 'server', 'python', '.venv', 'Scripts', 'python.exe');
  }
  return path.join(root, 'server', 'python', '.venv', 'bin', 'python');
}

function sidecarState(root) {
  const py = venvPython(root);
  const script = path.join(root, 'server', 'python', 'audio8_server.py');
  const models = path.join(root, 'models', 'audio8', 'config.json');
  return {
    py,
    script,
    pyOk: fs.existsSync(py),
    scriptOk: fs.existsSync(script),
    modelsOk: fs.existsSync(models),
  };
}

let sidecar = null;

// --- project-local profile --------------------------------------------------
// Everything Chromium persists (IndexedDB voice bank, caches, GPU blobs)
// lives in <project>/.user-data instead of %APPDATA% — no C: leftovers.
function redirectProfile() {
  const dir = path.join(projectRoot(), '.user-data');
  try {
    fs.mkdirSync(dir, { recursive: true });
    // one-time migration: carry the voice bank + prefs over from the legacy
    // %APPDATA% profile, then leave the old caches behind (regenerable).
    // Only project data moves; anything else in roaming stays untouched.
    const candidates = [
      path.join(app.getPath('appData'), app.getName()),
      path.join(app.getPath('appData'), 'HandScribe'),
    ];
    const keep = ['IndexedDB', 'Local Storage', 'Preferences'];
    for (const old of candidates) {
      for (const name of keep) {
        const src = path.join(old, name);
        const dst = path.join(dir, name);
        try {
          if (!fs.existsSync(dst) && fs.existsSync(src)) fs.renameSync(src, dst);
        } catch { /* keep the fresh profile on any failure */ }
      }
    }
  } catch { /* profile setup must never block startup */ }
  try {
    app.setPath('userData', dir);
  } catch { /* noop */ }
}
redirectProfile();

async function ensureSidecar(root, win) {
  const st = sidecarState(root);
  if (!st.pyOk || !st.scriptOk) {
    await dialog.showMessageBox(win || null, {
      type: 'warning',
      title: 'Audio8 GPU server not installed',
      message:
        'The project-local Python sidecar is missing.\n\n' +
        'Kokoro (in-browser voices) works fine without it.\n' +
        'For Audio8 GPU voices run scripts\\setup-audio8.bat once, then restart the app.',
    });
    return null;
  }
  if (!st.modelsOk) {
    await dialog.showMessageBox(win || null, {
      type: 'warning',
      title: 'Audio8 models not downloaded',
      message:
        'models\\audio8 is empty.\n\nRun scripts\\setup-audio8.bat once to download the checkpoint ' +
        'into the project folder, then restart the app. Kokoro voices work meanwhile.',
    });
  }
  // Something already answers on the port (previous session?) — reuse it.
  if (await portBusy(AUDIO8_PORT)) {
    const h = await health(AUDIO8_PORT);
    if (h.up) return 'external';
  }
  const logFile = path.join(root, 'server', 'python', 'server.log');
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  // sidecar temp files (STT wavs, …) stay in the project, not %TEMP%
  const tmpDir = path.join(root, '.cache', 'tmp');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* noop */ }
  sidecar = spawn(st.py, [st.script, '--host', '127.0.0.1', '--port', String(AUDIO8_PORT)], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TMPDIR: tmpDir, TEMP: tmpDir, TMP: tmpDir },
  });
  sidecar.stdout.pipe(log, { end: false });
  sidecar.stderr.pipe(log, { end: false });
  sidecar.on('exit', (code) => {
    sidecar = null;
    if (!app.isQuitting) {
      dialog
        .showMessageBox(win || null, {
          type: 'error',
          title: 'Audio8 GPU server stopped',
          message:
            `The local GPU server exited (code ${code}).\n\n` +
            'Kokoro voices keep working. Restart the app to bring Audio8 back.\n' +
            `Details: server\\python\\server.log`,
        })
        .catch(() => undefined);
    }
  });
  return 'managed';
}

// --- app lifecycle ------------------------------------------------------------
app.isQuitting = false;
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

async function createWindow() {
  const root = projectRoot();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    autoHideMenuBar: true,
    backgroundColor: '#09090b',
    title: 'HandScribe',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // CRITICAL for exports: Chromium throttles timers/rAF/WebCodecs in
      // occluded windows (e.g. Task Manager focused). Throttled, the export
      // pump crawls at ~4fps with CPU+GPU idle. Exports must run full-speed
      // while the user watches progress elsewhere.
      backgroundThrottling: false,
    },
  });

  if (isDev) {
    // Dev: sidecar managed, UI from vite (HMR).
    void ensureSidecar(root, win).then((mode) => {
      win.webContents.send('audio8-sidecar', { mode, port: AUDIO8_PORT });
    });
    await win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  const distDir = path.join(root, 'dist');
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Frontend not built',
      message: 'dist/index.html is missing.\n\nRun "npm run build" first, then start the desktop app again.',
    });
    app.quit();
    return;
  }

  // Start the sidecar first; show the UI as soon as it answers (model keeps
  // loading in the background — the panel's Test button shows progress).
  const mode = await ensureSidecar(root, win);
  const { server, port } = await serveDist(distDir);
  app.staticServer = server;
  await win.loadURL(`http://127.0.0.1:${port}/`);
  win.webContents.send('audio8-sidecar', { mode, port: AUDIO8_PORT });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  void createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  try {
    if (sidecar) sidecar.kill();
  } catch {
    /* noop */
  }
  try {
    if (app.staticServer) app.staticServer.close();
  } catch {
    /* noop */
  }
});
