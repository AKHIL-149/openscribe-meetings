// Built-in guest bot: joins a Meet / Teams / Zoom link as a visible, listen-only guest in a private browser
// window (in-memory profile: no cookies or sign-ins are kept) and streams the call's audio into the same
// local transcription pipeline used for normal recordings. No account, API key or cloud service involved.
//
// It drives the web pages with best-effort, text-based automation. Those pages change often, so every state
// is reported and the window can be shown (so a person can click through anything the automation can't).
import { app, BrowserWindow, ipcMain, session } from 'electron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TICK_MS = 1500;
const JOIN_TIMEOUT_MS = Number(process.env.MR_BOT_JOIN_TIMEOUT_MS) || 15 * 60 * 1000;   // host never admitted us
const SILENCE_MS = Number(process.env.MR_BOT_SILENCE_MS) || 10 * 60 * 1000;             // nobody has spoken for a while
const LOUD = 300; // |sample| above this (~ -40 dBFS) counts as sound

export const detectPlatform = (u) => /meet\.google\.com/.test(u) ? 'meet' : /zoom\.(us|com)/.test(u) ? 'zoom'
  : /teams\.(microsoft|live)\.com/.test(u) ? 'teams' : /webex\.com/.test(u) ? 'webex' : 'other';

/** Zoom invite links open the desktop app; the web client lives at /wc/join/<id>. */
export function webJoinUrl(href) {
  const u = new URL(href);
  const m = /^\/(?:j|w)\/(\d{8,12})/.exec(u.pathname);
  if (/zoom\.(us|com)$/.test(u.hostname) && m) return `https://${u.hostname}/wc/join/${m[1]}${u.search}`;
  return u.href;
}

/*
 * Runs inside the meeting page every tick. Returns { state, did } where state is one of:
 *   prejoin | waiting | incall | ended | denied | captcha | signin
 * and performs at most ONE action (type the name, dismiss a popup, press a join button).
 */
function STEP(platform, botName) {
  const text = (el) => (el.innerText || el.textContent || '').trim();
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const buttons = () => [...document.querySelectorAll('button, [role=button], input[type=button], input[type=submit]')].filter(visible);
  const label = (el) => `${text(el)} ${el.getAttribute('aria-label') || ''} ${el.value || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
  const usable = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  const body = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').toLowerCase();
  const find = (re, not) => buttons().find((b) => usable(b) && re.test(label(b)) && !(not && not.test(label(b))));
  // Act once per button: the page needs time to react, and repeated clicks/typing every tick look like flicker and can undo themselves.
  const recent = (window.__mrRecent = window.__mrRecent || {});
  const cooled = (key, ms) => { const now = Date.now(); if (recent[key] && now - recent[key] < ms) return false; recent[key] = now; return true; };
  const click = (re, not) => { const b = find(re, not); if (!b) return null; if (!cooled(label(b), 6000)) return null; b.click(); return label(b).slice(0, 50); };
  const setValue = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  if (/captcha|verify (that )?you('| a)re (a )?human|i'?m not a robot/.test(body)) return { state: 'captcha' };
  if (/you('ve| have) been removed from|removed you from the (meeting|call)|denied your request|your request to join was (denied|declined)|you can'?t join this (video )?(call|meeting)|not allowed to join|host has (ended|removed)/.test(body)) return { state: 'denied' };
  if (/the meeting has ended|this meeting has ended|meeting ended|you left the (meeting|call)|you('ve| have) left|call ended|thanks for joining|return to home screen|rejoin/.test(body) && !find(/^(leave|end)/)) return { state: 'ended' };
  if (/asking to be let in|someone will let you in|let you in soon|waiting for the host|host will let you in|in the lobby|waiting room|waiting for (someone|the organizer)/.test(body)) return { state: 'waiting' };
  if (find(/leave call|leave meeting|hang ?up|end call|leave$/, /leave (the )?(waiting|lobby)/)) {
    const did = platform === 'zoom' ? click(/join audio by computer|computer audio|join audio/) : click(/^got it$|^dismiss$/);
    return { state: 'incall', did };
  }

  const inputs = [...document.querySelectorAll('input')].filter(visible);
  const nameInput = inputs.find((i) => (!i.type || i.type === 'text') && /name/i.test(`${i.placeholder} ${i.getAttribute('aria-label')} ${i.id} ${i.name}`));
  if (nameInput && nameInput.value !== botName && cooled('name', 5000)) { setValue(nameInput, botName); return { state: 'prejoin', did: 'type name' }; }

  const did =
    click(/^(accept( all)?( cookies)?|i agree|agree|got it|dismiss|close)$/) ||
    click(/continue without (microphone|audio|camera)|use no (microphone|audio)|without (mic|audio)/) ||
    // Switch the (virtual) mic and camera off before joining, so the bot joins muted with no video.
    click(/turn off (microphone|camera)|mute microphone|stop video/) ||
    // Fallback for pages that still show a permission screen: pressing Allow is harmless, the devices are virtual.
    click(/allow (use of )?(your )?(microphone|camera)|use microphone and camera/) ||
    click(/continue on this browser|join on the web|use the web app|stay on (this|the) (browser|web)|join from your browser|launch meeting/) ||
    click(/ask to join|join now|join meeting|join as guest|join as .*guest|^join$|^join( meeting)?\b/, /join (with|using|from) (the )?(app|desktop|phone)|phone|present|companion|another device/);
  if (did) return { state: 'prejoin', did };
  if (/sign in to (join|continue)|you need to sign in|log in to join/.test(body) && !nameInput) return { state: 'signin' };
  return { state: 'prejoin' };
}
const STEP_SRC = (platform, name) => `(${STEP.toString()})(${JSON.stringify(platform)}, ${JSON.stringify(name)})`;

// Diagnostic log: which step the bot is on (never meeting content, links or names). Kept small.
function logStep(line) {
  try {
    const f = path.join(app.getPath('userData'), 'bot-steps.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 200_000) fs.writeFileSync(f, '');
    fs.appendFileSync(f, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch { /* logging must never break the bot */ }
}

const bots = new Map(); // meetingId -> bot
const bySender = new Map(); // webContents id -> bot

ipcMain.on('bot:audio', (e, ab) => {
  const bot = bySender.get(e.sender.id);
  if (!bot || bot.closed) return;
  const pcm = Buffer.from(ab);
  const s16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
  let peak = 0;
  for (let i = 0; i < s16.length; i += 8) { const a = Math.abs(s16[i]); if (a > peak) peak = a; }
  if (peak > LOUD) bot.lastSound = Date.now();
  bot.gotAudio = true;
  bot.onAudio(pcm);
});
ipcMain.on('bot:tracks', (e, n) => { const bot = bySender.get(e.sender.id); if (bot) bot.tracks = n; });

/**
 * Join a meeting. Callbacks: onStatus(code, detail?), onAudio(Buffer PCM16 16 kHz mono), onEnd(reason?, fatal?).
 * Returns { leave, show }.
 */
export function joinMeeting({ meetingId, url, name, useAccount = false, onStatus, onAudio, onEnd }) {
  if (bots.has(meetingId)) throw new Error('This bot is already running');
  const platform = detectPlatform(url);
  // Default: a throwaway in-memory profile (no "persist:" prefix), so nothing is written to disk.
  // With a saved bot sign-in the join uses the bot account's own profile instead (see openSignIn).
  const ses = useAccount ? session.fromPartition(ACCOUNT_PARTITION) : session.fromPartition(`bot-${meetingId}`);
  // Listen-only. The page is given a virtual silent mic/black camera (bot-preload.cjs), so it never needs a real
  // one: any real request is refused. Reporting mic/camera as "granted" just lets Meet skip its permission screen.
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler((_wc, perm) => perm === 'media');

  const win = new BrowserWindow({
    width: 1280, height: 800, show: false, title: `Bot: ${name}`,
    webPreferences: {
      session: ses, preload: path.join(HERE, 'bot-preload.cjs'),
      contextIsolation: false, sandbox: false, nodeIntegration: false, // preload must run in the page's world to wrap WebRTC
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.webContents.setAudioMuted(true); // the call is transcribed, not played through your speakers
  win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/ Electron\/\S+/, '').replace(/ meeting-recorder\/\S+/i, '').replace(/ Meeting Recorder\/\S+/i, ''));
  win.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:/.test(u)) win.loadURL(u); return { action: 'deny' }; });

  const bot = { id: meetingId, win, onAudio, closed: false, lastSound: Date.now(), gotAudio: false, tracks: 0, wasInCall: false, status: '' };
  bots.set(meetingId, bot);
  bySender.set(win.webContents.id, bot);

  const set = (code, detail) => { if (bot.status !== code) { bot.status = code; onStatus(code, detail); } };
  const finish = (reason, fatal = false) => {
    if (bot.closed) return;
    bot.closed = true;
    clearInterval(bot.timer);
    bots.delete(meetingId); bySender.delete(win.webContents.id);
    try { if (!win.isDestroyed()) win.destroy(); } catch { /* already gone */ }
    onEnd(reason, fatal);
  };
  bot.finish = finish;

  const startedAt = Date.now();
  let lastStep = '';
  let busy = false;
  bot.timer = setInterval(async () => {
    if (busy || bot.closed || win.isDestroyed()) return;
    busy = true;
    try {
      const r = await win.webContents.executeJavaScript(STEP_SRC(platform, name), true);
      const key = `${r.state}|${r.did || ''}`;
      if (key !== lastStep) { logStep(`${platform} ${r.state}${r.did ? ` (${r.did})` : ''}`); if (process.env.MR_DEBUG) console.log(`[bot ${platform}] ${r.state}${r.did ? ` (${r.did})` : ''}`); }
      lastStep = key;
      switch (r.state) {
        case 'prejoin': set('joining_call'); break;
        case 'waiting': set('in_waiting_room'); break;
        case 'incall': bot.wasInCall = true; set(bot.gotAudio ? 'in_call_recording' : 'in_call_not_recording'); break;
        case 'captcha': set('needs_you', 'The meeting site is asking for a human check. Click “Show bot window” and complete it.'); break;
        case 'signin': set('needs_you', 'This meeting only lets signed-in people join. Use “Sign the bot in” on the home screen (once), then send the bot again.'); break;
        case 'denied': finish('The host did not admit the bot (or removed it).', !bot.wasInCall); return;
        case 'ended': if (bot.wasInCall) { finish('The meeting ended.'); return; } break;
      }
      if (bot.wasInCall && bot.gotAudio) set('in_call_recording');
      if (!bot.wasInCall && Date.now() - startedAt > JOIN_TIMEOUT_MS) { finish('The bot was not let into the meeting in time.', true); return; }
      if (bot.wasInCall && Date.now() - bot.lastSound > SILENCE_MS) { finish('Nobody spoke for a long time, so the bot left.'); return; }
    } catch (e) {
      if (!bot.closed && !win.isDestroyed()) { /* page is mid-navigation: try again next tick */ }
    } finally { busy = false; }
  }, TICK_MS);

  win.on('closed', () => finish(bot.wasInCall ? 'The bot window was closed.' : 'The bot window was closed before joining.', !bot.wasInCall));
  win.webContents.on('did-fail-load', (_e, code, desc, u, isMain) => {
    if (isMain && code !== -3) finish(`Could not open the meeting link (${desc}).`, true);
  });

  set('joining_call');
  win.loadURL(webJoinUrl(url)).catch(() => { /* reported by did-fail-load */ });

  return {
    leave: () => {
      if (bot.closed) return;
      // Press the page's own Leave button so the host sees a clean exit, then close.
      win.webContents.executeJavaScript(`(()=>{const b=[...document.querySelectorAll('button,[role=button]')].find(e=>/leave call|leave meeting|hang ?up|end call|^leave$/i.test((e.innerText||'')+' '+(e.getAttribute('aria-label')||'')));if(b)b.click();})()`).catch(() => {});
      setTimeout(() => finish('You asked the bot to leave.'), 1200);
    },
    show: () => { if (!win.isDestroyed()) { win.show(); win.focus(); } },
  };
}

/*
 * Optional bot sign-in. Some meetings only admit signed-in people. The USER signs in themselves, in a normal
 * browser window the app opens; the app never reads, types or stores a password. What is kept is the site's
 * own session cookie, in this app's separate "bot account" browser profile (Chromium protects cookie values
 * with the OS keychain). Use a dedicated bot account, not a personal one. "Forget" wipes the profile.
 */
export const ACCOUNT_PARTITION = 'persist:bot-account';
const SIGN_IN_URLS = { google: 'https://accounts.google.com/', microsoft: 'https://login.microsoftonline.com/', zoom: 'https://zoom.us/signin' };

export function openSignIn(provider, onClosed) {
  const url = SIGN_IN_URLS[provider];
  if (!url) throw new Error('Unknown sign-in provider');
  const ses = session.fromPartition(ACCOUNT_PARTITION);
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  const win = new BrowserWindow({ width: 520, height: 720, title: 'Sign the bot in', webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/ Electron\/\S+/, '').replace(/ meeting-recorder\/\S+/i, '').replace(/ Meeting Recorder\/\S+/i, ''));
  win.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https:/.test(u)) win.loadURL(u); return { action: 'deny' }; });
  win.on('closed', () => onClosed?.());
  win.loadURL(url);
}

export async function forgetSignIn() {
  const ses = session.fromPartition(ACCOUNT_PARTITION);
  await ses.clearStorageData();
  await ses.clearCache();
}

export function leaveAllBots() { for (const b of [...bots.values()]) b.finish('The app is closing.'); }
