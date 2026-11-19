// Desktop shell: runs the recorder server inside the app and shows it in a native window.
import { app, BrowserWindow, Menu, desktopCapturer, dialog, safeStorage, session, shell, systemPreferences } from 'electron';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// TEST SAFETY: automated runs (MR_SMOKE / MR_E2E_SCRIPT) must use an isolated profile, never the real one.
// MR_USER_DATA points the whole app (data, models, keychain-sealed key) at a throwaway folder.
if (process.env.MR_USER_DATA) app.setPath('userData', process.env.MR_USER_DATA);
if ((process.env.MR_SMOKE || process.env.MR_E2E_SCRIPT) && !process.env.MR_USER_DATA) {
  console.error('Refusing to run a test against your real data. Set MR_USER_DATA to a throwaway folder (scripts/e2e-electron.mjs does this).');
  app.exit(2);
}

if (!app.requestSingleInstanceLock()) app.quit();

// Test hooks (inactive unless these env vars are set): feed a WAV file in as the microphone and run a
// script inside the page, so the real UI can be exercised without a person at the keyboard.
if (process.env.MR_FAKE_AUDIO) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.MR_FAKE_AUDIO);
}
const HEADLESS_TEST = Boolean(process.env.MR_SMOKE || process.env.MR_E2E_SCRIPT);

// Everything the server stores (recordings, transcripts, settings) lives in the OS app-data folder.
process.env.MR_DATA_DIR = path.join(app.getPath('userData'), 'data');
// The speech engine runs under a bundled, real Node.js (ONNX Runtime crashes inside Electron's runtime).
if (app.isPackaged) process.env.MR_NODE_BIN = path.join(process.resourcesPath, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
process.env.PORT = '0'; // pick any free port
process.env.HOST = '127.0.0.1';

// The vault master key is encrypted with the OS (macOS Keychain / Windows DPAPI) and only ever held
// in memory while the app runs. If the OS cannot protect it, the server falls back to a 0600 key file.
async function loadMasterKey() {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return; // e.g. Linux without a keyring: server uses a 0600 key file
  const file = path.join(app.getPath('userData'), 'vault.key.enc');
  let key;
  if (fs.existsSync(file)) {
    // NEVER generate a new key when one exists: that would make every saved meeting unreadable.
    const r = await safeStorage.decryptStringAsync(fs.readFileSync(file));
    key = typeof r === 'string' ? r : r.result;
    if (!key || key.length !== 64) throw new Error('The stored encryption key is unreadable.');
    if (typeof r === 'object' && r.shouldReEncrypt) fs.writeFileSync(file, await safeStorage.encryptStringAsync(key), { mode: 0o600 });
  } else {
    key = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, await safeStorage.encryptStringAsync(key), { mode: 0o600 });
  }
  process.env.MR_MASTER_KEY = key;
  process.env.MR_MASTER_KEY_SOURCE = process.platform === 'darwin' ? 'macOS Keychain' : process.platform === 'win32' ? 'Windows DPAPI' : 'OS keyring';
}

let win;
let origin = '';

function createWindow(port) {
  origin = `http://127.0.0.1:${port}`;
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 760, minHeight: 520,
    show: !HEADLESS_TEST,
    title: 'Meeting Recorder',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: !HEADLESS_TEST },
  });
  win.loadURL(origin);

  // Links leave the app; navigation stays on our own server.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });

  // While a recording is running, closing the window asks first instead of silently losing it.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Keep recording', 'Quit anyway'], defaultId: 0, cancelId: 0,
      message: 'A recording is in progress.', detail: 'If you quit now, the recording will not be saved.',
    });
    if (choice === 1) e.preventDefault(); // ignore the page's "stay" request
  });
}

function setupPermissions() {
  const ses = session.defaultSession;
  // Data stays on this computer: the app window may only talk to the app's own local server. Anything else
  // (analytics, fonts, CDNs, a compromised dependency phoning home) is refused. Downloads of models and the
  // optional cloud services run in the server process, not here, and are listed in PRIVACY.md.
  ses.webRequest.onBeforeRequest((details, cb) => {
    let ok = false;
    try { const u = new URL(details.url); ok = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || ['data:', 'blob:', 'devtools:', 'file:'].includes(u.protocol); } catch { /* unparsable: refuse */ }
    if (!ok) console.error('[privacy] blocked a request from the app window to an outside address');
    cb({ cancel: !ok });
  });
  const ours = (url) => url.startsWith(origin);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(['media', 'display-capture'].includes(permission) && ours(details.requestingUrl)));
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => ['media', 'display-capture'].includes(permission) && requestingOrigin.startsWith(origin));

  // "Share screen" without a picker: Windows hands us the whole system's audio (loopback).
  // On macOS 15+ the OS picker is used; Electron cannot loop back system audio on macOS, so there
  // the app records the chosen input device (e.g. a BlackHole loopback device) instead.
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      if (!sources.length) return callback(null);
      callback(process.platform === 'win32' ? { video: sources[0], audio: 'loopback' } : { video: sources[0] });
    } catch { callback(null); }
  }, { useSystemPicker: process.platform === 'darwin' });
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  try { await loadMasterKey(); } catch (e) {
    dialog.showErrorBox('Cannot unlock your meetings',
      `${e.message}\n\nYour recordings are encrypted and the key could not be read from the system keychain. Nothing was changed or deleted. Make sure you are signed in as the same user and allow keychain access, then start the app again.`);
    app.quit();
    return;
  }
  const { listening, setBotHost } = await import('../server.js');
  const { joinMeeting, leaveAllBots, openSignIn, forgetSignIn } = await import('./bot.js');
  setBotHost({ join: joinMeeting, openSignIn, forgetSignIn });
  app.on('before-quit', leaveAllBots);
  const port = await listening;
  setupPermissions();
  if (process.platform === 'darwin') {
    // Triggers the macOS microphone prompt up front so the first recording works.
    systemPreferences.askForMediaAccess('microphone').catch(() => {});
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  createWindow(port);

  if (process.env.MR_SMOKE) { // used by automated checks: report what the window rendered, then exit
    win.webContents.on('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const text = await win.webContents.executeJavaScript('document.title + " | " + document.querySelector("#status").textContent + " | " + document.querySelector("h1").textContent');
      console.log('SMOKE:', text);
      app.quit();
    });
  }
  if (process.env.MR_E2E_SCRIPT) {
    win.webContents.on('did-finish-load', async () => {
      try {
        const result = await win.webContents.executeJavaScript(fs.readFileSync(process.env.MR_E2E_SCRIPT, 'utf8'), true);
        console.log('E2E:', JSON.stringify(result, null, 1));
      } catch (e) { console.log('E2E-ERROR:', e.message); }
      app.quit();
    });
  }
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(port); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
