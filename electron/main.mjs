import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { autoUpdater } from 'electron-updater';

const APP_PORT = Number(process.env.PORT || 3187);
const APP_URL = `http://127.0.0.1:${APP_PORT}`;

let mainWindow = null;
let splashWindow = null;
let serverProcess = null;
let updateState = { status: 'idle', message: '' };

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
      const res = await fetch(`${url}/api/setup/status`);
      if (res.ok) return true;
    } catch {
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
      PORT: String(APP_PORT)
    },
    stdio: 'ignore'
  });

  serverProcess.on('exit', () => {
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

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }
    mainWindow.show();
  });

  mainWindow.loadURL(APP_URL);
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
