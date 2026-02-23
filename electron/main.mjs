import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import updaterPkg from 'electron-updater';

const { autoUpdater } = updaterPkg;

const APP_PORT = Number(process.env.PORT || 3187);
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const API_TOKEN = process.env.API_TOKEN || randomUUID();

let mainWindow = null;
let splashWindow = null;
let serverProcess = null;
let updateState = { status: 'idle', message: '' };
let startupLogPath = '';
let lastStartupProbe = 'sin detalles';

function logStartup(message) {
  const line = `[${new Date().toISOString()}] ${String(message)}\n`;
  try {
    if (startupLogPath) appendFileSync(startupLogPath, line, 'utf8');
  } catch {
    // Best effort logging only.
  }
  console.error(line.trim());
}

function sendUpdateState(patch = {}) {
  updateState = { ...updateState, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:status', updateState);
  }
}

async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const setupUrl = new URL('/api/setup/status', url);
      setupUrl.searchParams.set('_token', API_TOKEN);
      const res = await fetch(setupUrl.toString(), {
        headers: {
          'x-api-token': API_TOKEN
        }
      });
      if (res.ok) return true;
      lastStartupProbe = `HTTP ${res.status} en /api/setup/status`;
    } catch (error) {
      lastStartupProbe = `fetch error: ${error?.message || String(error)}`;
      // Keep polling until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

function startBackend() {
  const serverEntry = join(app.getAppPath(), 'server.js');
  serverProcess = fork(serverEntry, [], {
    cwd: app.getAppPath(),
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      API_TOKEN
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });

  serverProcess.stdout?.on('data', (chunk) => {
    logStartup(`[backend stdout] ${String(chunk).trim()}`);
  });
  serverProcess.stderr?.on('data', (chunk) => {
    logStartup(`[backend stderr] ${String(chunk).trim()}`);
  });

  serverProcess.on('error', (error) => {
    logStartup(`[backend error] ${error?.message || String(error)}`);
  });

  serverProcess.on('exit', (code, signal) => {
    logStartup(`[backend exit] code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    serverProcess = null;
  });
}

function createWindow() {
  const appIcon = join(app.getAppPath(), 'build', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 860,
    minWidth: 980,
    minHeight: 720,
    autoHideMenuBar: true,
    show: false,
    icon: appIcon,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: join(app.getAppPath(), 'electron', 'preload.cjs')
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = new URL(APP_URL).origin;
    if (!new URL(url).origin.startsWith(allowed)) {
      event.preventDefault();
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }
    mainWindow.show();
  });

  const appUrl = new URL(APP_URL);
  appUrl.searchParams.set('_token', API_TOKEN);
  mainWindow.loadURL(appUrl.toString());
}

function configureAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    sendUpdateState({ status: 'checking', message: 'Buscando actualizaciones...' });
  });
  autoUpdater.on('update-available', (info) => {
    sendUpdateState({
      status: 'available',
      version: info?.version || '',
      message: `Nueva versión disponible: ${info?.version || 'desconocida'}`
    });
  });
  autoUpdater.on('update-not-available', (info) => {
    sendUpdateState({
      status: 'not-available',
      version: info?.version || app.getVersion(),
      message: 'Ya tienes la última versión.'
    });
  });
  autoUpdater.on('download-progress', (progress) => {
    sendUpdateState({
      status: 'downloading',
      progress: Math.round(progress?.percent || 0),
      message: `Descargando actualización: ${Math.round(progress?.percent || 0)}%`
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateState({
      status: 'downloaded',
      version: info?.version || '',
      message: 'Actualización descargada. Reinicia para instalar.'
    });
  });
  autoUpdater.on('error', (error) => {
    sendUpdateState({
      status: 'error',
      message: `Error de actualización: ${error?.message || String(error)}`
    });
  });

  ipcMain.handle('updater:get-state', () => updateState);
  ipcMain.handle('updater:check', async () => {
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (error) {
      sendUpdateState({
        status: 'error',
        message: `No se pudo comprobar actualización: ${error?.message || String(error)}`
      });
      return { ok: false, error: String(error?.message || error) };
    }
  });
  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (error) {
      sendUpdateState({
        status: 'error',
        message: `No se pudo descargar actualización: ${error?.message || String(error)}`
      });
      return { ok: false, error: String(error?.message || error) };
    }
  });
  ipcMain.handle('updater:install', () => {
    autoUpdater.quitAndInstall();
    return { ok: true };
  });
}

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 460,
    height: 340,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    transparent: false,
    autoHideMenuBar: true,
    show: true,
    icon: join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      sandbox: true
    }
  });

  splashWindow.loadFile(join(app.getAppPath(), 'electron', 'splash.html'));
}

app.on('web-contents-created', (_event, contents) => {
  contents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
      return;
    }
    callback(false);
  });
});

app.whenReady().then(async () => {
  const logDir = join(app.getPath('userData'), 'logs');
  mkdirSync(logDir, { recursive: true });
  startupLogPath = join(logDir, 'startup.log');
  logStartup('App startup begin');

  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    if (permission === 'media') return true;
    return false;
  });

  createSplash();
  startBackend();
  const ok = await waitForServer(APP_URL, 45000);

  if (!ok) {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }
    dialog.showErrorBox(
      'Error al iniciar Voice PC Agent',
      [
        'No se pudo iniciar el backend local.',
        `Último estado: ${lastStartupProbe}`,
        '',
        `Log de arranque: ${startupLogPath}`,
        'Compárteme ese log para diagnosticar el fallo exacto.'
      ].join('\n')
    );
    app.quit();
    return;
  }

  createWindow();
  configureAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
});
