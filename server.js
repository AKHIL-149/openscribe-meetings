import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { hardware, sttLadder, LocalSTT, Segmenter, isHallucination } from './local.js';
import { SpeakerEngine, SpeakerTracker, splitUtterance, refineMeeting, speakerStats, voiceprintOf, toB64, fromB64, normalize } from './speakers.js';
import { BuiltinLLM, recommendBuiltin } from './builtin-llm.js';
import { resolveEngine, ollamaModels, pickInstalled, recommendLLM, pullModel, summarize, ask } from './llm.js';
import { initVault, vaultInfo, ensureDir, readJSON, writeJSON, encryptTo, decryptRange, plainSize, appendEncrypted, storedSize } from './vault.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* .env is optional */ }

const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_ROOT = process.env.MR_DATA_DIR || path.join(__dirname, 'data');
const DATA_DIR = path.join(DATA_ROOT, 'meetings');
const SETTINGS_FILE = path.join(DATA_ROOT, 'settings.json');
const DEBUG = Boolean(process.env.MR_DEBUG);
const RECALL_BASE_OVERRIDE = process.env.RECALL_BASE_URL || '';

ensureDir(DATA_ROOT);
initVault(DATA_ROOT);

// Settings: values saved from the in-app Settings screen win over .env / environment variables.
let DEEPGRAM_KEY, ANTHROPIC_KEY, MODEL, LANGUAGE, RECALL_KEY, RECALL_REGION, RECALL_BASE;
let STT_PROVIDER, STT_MODEL, LLM_PROVIDER, LLM_MODEL, OLLAMA_HOST, SPEAKER_ID, BOT_PROVIDER;
function loadSettings() {
  let saved = {};
  try {
    const r = readJSON(SETTINGS_FILE);
    saved = r.obj;
    if (r.legacy) writeJSON(SETTINGS_FILE, saved); // migrate plaintext settings to the vault
  } catch { /* none yet */ }
  const pick = (k, env, dflt = '') => (typeof saved[k] === 'string' && saved[k] !== '' ? saved[k] : process.env[env] || dflt);
  DEEPGRAM_KEY = pick('deepgramKey', 'DEEPGRAM_API_KEY');
  ANTHROPIC_KEY = pick('anthropicKey', 'ANTHROPIC_API_KEY');
  MODEL = pick('anthropicModel', 'ANTHROPIC_MODEL', 'claude-sonnet-5-5');
  LANGUAGE = pick('language', 'TRANSCRIBE_LANGUAGE', 'en');
  RECALL_KEY = pick('recallKey', 'RECALL_API_KEY');
  RECALL_REGION = pick('recallRegion', 'RECALL_REGION', 'us-west-2'); // must match your Recall.ai account region
  STT_PROVIDER = pick('sttProvider', 'STT_PROVIDER', 'local');   // local | deepgram
  STT_MODEL = pick('sttModel', 'STT_MODEL', 'auto');             // auto | turbo | small | base | tiny
  LLM_PROVIDER = pick('llmProvider', 'LLM_PROVIDER', 'auto');    // auto | local | anthropic
  LLM_MODEL = pick('llmModel', 'LLM_MODEL', 'auto');             // auto | an Ollama model name
  BOT_PROVIDER = pick('botProvider', 'BOT_PROVIDER', 'auto');       // auto (built-in guest bot first) | local | recall
  SPEAKER_ID = pick('speakerId', 'SPEAKER_ID', 'on');               // on | off: recognise and label individual speakers
  OLLAMA_HOST = pick('ollamaHost', 'OLLAMA_HOST', 'http://127.0.0.1:11434').replace(/\/$/, '');
  if (!/^https?:\/\//.test(OLLAMA_HOST)) OLLAMA_HOST = `http://${OLLAMA_HOST}`;
  RECALL_BASE = RECALL_BASE_OVERRIDE || `https://${RECALL_REGION}.recall.ai/api/v1`;
}
loadSettings();

ensureDir(DATA_DIR);

/* ------------------------------------------------------------------ store */

const meetings = new Map();
const ID_RE = /^[a-z0-9-]{8,64}$/;
const dir = (id) => path.join(DATA_DIR, id);
// Recordings are stored encrypted, as <name>.enc.
const audioPath = (m) => path.join(dir(m.id), `${m.mediaFile || 'audio.webm'}.enc`);
const MIME = { '.webm': 'audio/webm', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg' };

function ensureIds(m) { // stable per-segment ids so a single line can be corrected later
  let max = m.transcript.reduce((a, t) => Math.max(a, t.id || 0), 0);
  for (const t of m.transcript) if (!t.id) t.id = ++max;
  m.nextSeg = max;
}

function save(m) {
  ensureIds(m);
  ensureDir(dir(m.id));
  writeJSON(path.join(dir(m.id), 'meeting.json'), m);
}

let unreadable = 0;
for (const id of fs.readdirSync(DATA_DIR)) {
  try {
    const { obj: m, legacy } = readJSON(path.join(DATA_DIR, id, 'meeting.json'));
    if (legacy) save(m); // migrate: re-save plaintext records encrypted
    // The app or server died mid-recording: keep everything captured so far (transcript and the audio that was
    // already written to disk) and mark the meeting as interrupted so the user knows it was cut off.
    if (m.status === 'recording') {
      m.status = 'ended';
      m.interrupted = true;
      m.endedAt = m.endedAt || new Date().toISOString();
      if (!m.durationSec) { const last = m.transcript.at(-1); m.durationSec = last ? Math.ceil(last.start + (last.dur || 0)) : 0; }
      save(m);
    }
    ensureIds(m);
    meetings.set(m.id, m);
    // Migrate a plaintext recording from an older version.
    const plain = path.join(DATA_DIR, id, m.mediaFile || 'audio.webm');
    if (m.hasAudio && fs.existsSync(plain) && !fs.existsSync(audioPath(m))) {
      encryptTo(fs.createReadStream(plain), audioPath(m)).then(() => fs.rmSync(plain, { force: true }))
        .catch((e) => console.error(`could not encrypt recording ${id}: ${e.message}`));
    }
  } catch (e) { unreadable++; console.error(`skipping unreadable meeting ${id}: ${e.message}`); }
}
if (unreadable) console.error(`WARNING: ${unreadable} meeting(s) could not be decrypted (wrong or missing key, or the file was modified). They were left untouched on disk.`);

const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
};
const transcriptText = (m) => m.transcript.map((t) => `[${fmtTime(t.start)}] ${t.speaker}${t.uncertain ? ' (?)' : ''}: ${t.text}`).join('\n');
const listView = ({ transcript, ...rest }) => ({ ...rest, segments: transcript.length });

// What the browser sees: no voiceprints, plus per-speaker characterization.
const publicMeeting = (m) => ({
  ...m,
  transcript: m.transcript.map(({ emb, ...seg }) => seg),
  speakers: speakerStats(m.transcript),
  hasVoiceprints: m.transcript.some((t) => t.emb),
});

/* ------------------------------------------------- speaker recognition */

// Remembered voices are biometric data: stored only in the encrypted vault, only when the user asks,
// and deletable at any time.
const VOICES_FILE = path.join(DATA_ROOT, 'voices.json');
let voices = []; // [{ id, name, emb (base64 unit vector), n, updatedAt }]
try { voices = readJSON(VOICES_FILE).obj; } catch { voices = []; }
const saveVoices = () => writeJSON(VOICES_FILE, voices);
const voiceProfiles = () => voices.map((v) => ({ id: v.id, name: v.name, emb: fromB64(v.emb), n: v.n }));
const voiceView = (v) => ({ id: v.id, name: v.name, samples: v.n, updatedAt: v.updatedAt });
const spk = new SpeakerEngine({ modelDir: path.join(DATA_ROOT, 'models', 'speaker') });
const speakerOn = () => SPEAKER_ID === 'on';

/* ------------------------------------------------------------- AI engines */

const stt = new LocalSTT({ cacheDir: path.join(DATA_ROOT, 'models') });
const useDeepgram = () => STT_PROVIDER === 'deepgram' && Boolean(DEEPGRAM_KEY);
const builtin = new BuiltinLLM({ dir: path.join(DATA_ROOT, 'models', 'llm') });
const engineOpts = () => ({ builtin, provider: LLM_PROVIDER, model: LLM_MODEL, ollamaHost: OLLAMA_HOST, anthropicKey: ANTHROPIC_KEY, anthropicModel: MODEL });
let engineCache = { at: 0, v: null };
async function getEngine() { // short cache: config is polled by the UI and Ollama probing is not free
  if (Date.now() - engineCache.at > 4000) engineCache = { at: Date.now(), v: await resolveEngine(engineOpts()) };
  return engineCache.v;
}
const NO_ENGINE = 'No AI model is set up yet. Open ⚙ Settings and click “Download the summary model” (one free download, runs on this computer).';
const pullState = { active: false, model: '', status: '', completed: 0, total: 0, error: null };

/* --------------------------------------------------------------------- app */

const app = express();
app.use((req, res, next) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (HOST === '127.0.0.1' && !['127.0.0.1', 'localhost', '[::1]'].includes(host)) return res.status(403).end('Forbidden host');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  res.status(err.status || 500).json({ error: err.message });
});
const getMeeting = (req) => {
  const m = ID_RE.test(req.params.id) && meetings.get(req.params.id);
  if (!m) throw Object.assign(new Error('Meeting not found'), { status: 404 });
  return m;
};

const mask = (v) => (v ? `••••${v.slice(-4)}` : '');
app.get('/api/settings', (_req, res) => res.json({
  deepgramKey: mask(DEEPGRAM_KEY), anthropicKey: mask(ANTHROPIC_KEY), recallKey: mask(RECALL_KEY),
  recallRegion: RECALL_REGION, language: LANGUAGE,
  botProvider: BOT_PROVIDER, sttProvider: STT_PROVIDER, sttModel: STT_MODEL, llmProvider: LLM_PROVIDER, llmModel: LLM_MODEL, speakerId: SPEAKER_ID,
}));
app.put('/api/settings', (req, res) => {
  let saved = {};
  try { saved = readJSON(SETTINGS_FILE).obj; } catch { /* new file */ }
  const b = req.body || {};
  for (const k of ['deepgramKey', 'anthropicKey', 'recallKey']) {
    if (typeof b[k] === 'string' && !b[k].startsWith('••••')) saved[k] = b[k].trim().slice(0, 300); // masked value = unchanged
  }
  if (['us-west-2', 'us-east-1', 'eu-central-1', 'ap-northeast-1'].includes(b.recallRegion)) saved.recallRegion = b.recallRegion;
  if (typeof b.language === 'string' && /^[a-zA-Z-]{2,10}$/.test(b.language)) saved.language = b.language;
  if (['local', 'deepgram'].includes(b.sttProvider)) saved.sttProvider = b.sttProvider;
  if (['auto', 'turbo', 'small', 'base', 'tiny'].includes(b.sttModel)) saved.sttModel = b.sttModel;
  if (['auto', 'local', 'builtin', 'anthropic'].includes(b.llmProvider)) saved.llmProvider = b.llmProvider;
  if (['on', 'off'].includes(b.speakerId)) saved.speakerId = b.speakerId;
  if (['auto', 'local', 'recall'].includes(b.botProvider)) saved.botProvider = b.botProvider;
  if (typeof b.llmModel === 'string' && /^(auto|[\w.:/-]{1,80})$/.test(b.llmModel)) saved.llmModel = b.llmModel;
  writeJSON(SETTINGS_FILE, saved);
  loadSettings();
  engineCache = { at: 0, v: null };
  res.json({ ok: true });
});

app.get('/api/config', wrap(async (_req, res) => {
  const engine = await getEngine();
  res.json({
    transcription: useDeepgram() ? 'deepgram' : 'local',
    ai: Boolean(engine), aiProvider: engine?.provider || null, aiModel: engine?.model || null,
    bots: Boolean(RECALL_KEY) || Boolean(botHost),
    botProvider: useLocalBot() ? 'local' : RECALL_KEY ? 'recall' : null,
    language: LANGUAGE,
    storage: vaultInfo(),
  });
}));

// What this machine can run, which models were picked, and download progress.
app.get('/api/local/status', wrap(async (_req, res) => {
  const models = await ollamaModels(OLLAMA_HOST);
  const installedPick = models && (LLM_MODEL !== 'auto' ? models.find((m) => m.name === LLM_MODEL) : pickInstalled(models));
  res.json({
    hardware: hardware(),
    stt: { provider: useDeepgram() ? 'deepgram' : 'local', setting: STT_MODEL, ladder: sttLadder(LANGUAGE), chosen: stt.current(LANGUAGE, STT_MODEL), engine: stt.status() },
    speaker: { enabled: speakerOn(), engine: spk.status(), voices: voices.length },
    llm: { builtin: builtin.status(), reachable: models !== null, installed: models || [], chosen: installedPick || null, recommended: recommendLLM(), pull: pullState },
  });
}));

app.post('/api/local/stt/load', (_req, res) => { // pre-download the speech model so the first call starts instantly
  stt.ensure(LANGUAGE, STT_MODEL).catch(() => {});
  if (speakerOn()) spk.ensure().catch(() => {}); // also fetch the (small) speaker-recognition models
  res.json({ ok: true });
});

// Bundled model: one click, no Ollama.
app.post('/api/local/llm/builtin/download', wrap(async (_req, res) => {
  if (!recommendBuiltin()) throw Object.assign(new Error('This computer has less than 6 GB of memory, which is too little for the bundled model.'), { status: 400 });
  if (builtin.status().state === 'downloading') throw Object.assign(new Error('Already downloading'), { status: 409 });
  builtin.download().then(() => { engineCache = { at: 0, v: null }; }).catch((e) => console.error(`[llm] download failed: ${e.message}`));
  res.json({ ok: true });
}));

app.post('/api/local/llm/pull', wrap(async (req, res) => {
  const name = String(req.body?.model || recommendLLM().name);
  if (!/^[\w.:/-]{1,80}$/.test(name)) throw Object.assign(new Error('Invalid model name'), { status: 400 });
  if (pullState.active) throw Object.assign(new Error(`Already downloading ${pullState.model}`), { status: 409 });
  if ((await ollamaModels(OLLAMA_HOST)) === null) throw Object.assign(new Error('Ollama is not running. Install it from ollama.com and start it, then try again.'), { status: 400 });
  Object.assign(pullState, { active: true, model: name, status: 'starting', completed: 0, total: 0, error: null });
  pullModel(OLLAMA_HOST, name, (j) => Object.assign(pullState, { status: j.status || pullState.status, completed: j.completed ?? pullState.completed, total: j.total ?? pullState.total }))
    .catch((e) => { pullState.error = e.message; })
    .finally(() => { pullState.active = false; if (!pullState.error) pullState.status = 'done'; engineCache = { at: 0, v: null }; });
  res.json({ ok: true, model: name });
}));

/* ------------------------------------------------------ meeting bot (Recall.ai) */

/*
 * Built-in guest bot. The desktop shell (electron/main.js) registers a host that can open a private browser
 * window, join the call as a guest and hand us its audio. Without it (plain `npm start`) only Recall.ai is available.
 */
let botHost = null;
export const setBotHost = (h) => { botHost = h; };
const localBots = new Map(); // meetingId -> { leave, show }
const useLocalBot = () => Boolean(botHost) && BOT_PROVIDER !== 'recall';

const BOT_TERMINAL = new Set(['done', 'fatal']);
const importing = new Set();

async function recall(pathname, { method = 'GET', body } = {}) {
  if (!RECALL_KEY) throw Object.assign(new Error('RECALL_API_KEY is not set'), { status: 400 });
  const r = await fetch(`${RECALL_BASE}${pathname}`, {
    method,
    headers: { Authorization: `Token ${RECALL_KEY}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.detail || data?.message || JSON.stringify(data).slice(0, 200);
    throw Object.assign(new Error(`Recall.ai error ${r.status}: ${msg}`), { status: r.status === 507 ? 503 : 502 });
  }
  return data;
}

const detectPlatform = (u) => /meet\.google\.com/.test(u) ? 'meet' : /zoom\.(us|com)/.test(u) ? 'zoom'
  : /teams\.(microsoft|live)\.com/.test(u) ? 'teams' : /webex\.com/.test(u) ? 'webex' : 'other';

app.post('/api/bots', wrap(async (req, res) => {
  let url;
  try { url = new URL(String(req.body.meetingUrl || '').trim()); } catch { /* handled below */ }
  if (!url || !/^https?:$/.test(url.protocol)) throw Object.assign(new Error('Enter a valid meeting link (https://…)'), { status: 400 });
  const botName = String(req.body.botName || 'Meeting Notetaker').slice(0, 100);
  if (useLocalBot()) return res.status(201).json(startLocalBot(url, botName, String(req.body.title || '').slice(0, 200)));
  const bot = await recall('/bot/', {
    method: 'POST',
    body: { meeting_url: url.href, bot_name: botName, recording_config: { transcript: { provider: { recallai_streaming: {} } } } },
  });
  const m = {
    id: crypto.randomUUID(),
    title: String(req.body.title || '').slice(0, 200) || `Meeting ${new Date().toLocaleString()}`,
    platform: detectPlatform(url.href),
    source: 'bot',
    botId: bot.id,
    botStatus: 'joining_call',
    createdAt: new Date().toISOString(),
    endedAt: null,
    durationSec: 0,
    status: 'bot',
    hasAudio: false,
    transcript: [],
    summary: null,
  };
  meetings.set(m.id, m);
  save(m);
  res.status(201).json(m);
}));

function startLocalBot(url, botName, title) {
  const m = {
    id: crypto.randomUUID(),
    title: title || `Meeting ${new Date().toLocaleString()}`,
    platform: detectPlatform(url.href),
    source: 'bot', localBot: true,
    botStatus: 'joining_call',
    createdAt: new Date().toISOString(),
    endedAt: null, durationSec: 0,
    status: 'recording',   // same lifecycle as a normal recording: live transcript, crash recovery, summary on end
    hasAudio: false,       // the bot transcribes the call but does not keep the audio
    transcript: [], summary: null,
  };
  meetings.set(m.id, m);
  save(m);
  const S = createSession(m, { lang: LANGUAGE, diarizeMic: false });
  sessions.set(m.id, S);
  const startedAt = Date.now();
  let handle;
  try {
    handle = botHost.join({
      meetingId: m.id, url: url.href, name: botName,
      onStatus: (code, detail) => { m.botStatus = code; if (detail) m.botNote = detail; else delete m.botNote; save(m); },
      onAudio: (pcm) => S.push(Buffer.concat([Buffer.from([1]), pcm])),
      onEnd: (reason, fatal) => {
        localBots.delete(m.id);
        if (fatal && !m.transcript.length) m.botError = reason; else m.botNote = reason;
        m.botStatus = fatal && !m.transcript.length ? 'fatal' : 'done';
        S.stop((Date.now() - startedAt) / 1000);
      },
    });
  } catch (e) {
    sessions.delete(m.id); meetings.delete(m.id);
    try { fs.rmSync(path.join(DATA_DIR, m.id), { recursive: true, force: true }); } catch { /* best effort */ }
    throw Object.assign(new Error(`Could not start the bot: ${e.message}`), { status: 500 });
  }
  localBots.set(m.id, handle);
  return m;
}

app.post('/api/meetings/:id/bot/show', wrap((req, res) => {
  const h = localBots.get(getMeeting(req).id);
  if (!h) throw Object.assign(new Error('This bot is not running'), { status: 400 });
  h.show(); res.json({ ok: true });
}));

app.post('/api/meetings/:id/leave', wrap(async (req, res) => {
  const m = getMeeting(req);
  const local = localBots.get(m.id);
  if (local) { local.leave(); return res.json({ ok: true }); }
  if (!m.botId || m.status !== 'bot') throw Object.assign(new Error('No active bot for this meeting'), { status: 400 });
  await recall(`/bot/${m.botId}/leave_call/`, { method: 'POST' });
  res.json({ ok: true });
}));

async function download(url, dest) {
  const r = await fetch(url); // pre-signed URL: must NOT carry our Authorization header
  if (!r.ok || !r.body) throw new Error(`download failed (${r.status})`);
  await encryptTo(Readable.fromWeb(r.body), dest);
}

function recallTranscriptToSegments(parts) {
  const segs = [];
  for (const p of parts || []) {
    const words = (p.words || []).filter((w) => w.text);
    if (!words.length) continue;
    segs.push({
      speaker: p.participant?.name || `Speaker ${p.participant?.id ?? '?'}`,
      start: words[0].start_timestamp?.relative ?? 0,
      text: words.map((w) => w.text).join(' '),
    });
  }
  return segs.sort((a, b) => a.start - b.start);
}

async function importBotResults(m, bot) {
  const rec = bot.recordings?.[0];
  const shortcuts = rec?.media_shortcuts || {};
  const tUrl = shortcuts.transcript?.data?.download_url;
  if (tUrl) {
    const r = await fetch(tUrl);
    if (r.ok) m.transcript = recallTranscriptToSegments(await r.json());
  }
  const mUrl = shortcuts.video_mixed?.data?.download_url || shortcuts.audio_mixed?.data?.download_url;
  if (mUrl) {
    const ext = shortcuts.video_mixed?.data?.download_url ? '.mp4' : '.mp3';
    m.mediaFile = `media${ext}`;
    await download(mUrl, audioPath(m));
    m.hasAudio = true;
  }
  const last = m.transcript.at(-1);
  m.durationSec = m.durationSec || Math.ceil(last?.start || 0);
}

async function pollBot(m) {
  if (importing.has(m.id)) return;
  const bot = await recall(`/bot/${m.botId}/`);
  const code = bot.status_changes?.at(-1)?.code || m.botStatus;
  m.botStatus = String(code).replace(/^bot\./, '');
  if (!BOT_TERMINAL.has(m.botStatus)) return save(m);

  importing.add(m.id);
  try {
    if (m.botStatus === 'fatal') {
      m.botError = bot.status_changes?.at(-1)?.sub_code || 'The bot failed to record this meeting.';
    } else {
      await importBotResults(m, bot);
    }
    m.status = 'ended';
    m.endedAt = new Date().toISOString();
  } catch (e) {
    console.error(`bot import failed for ${m.id}: ${e.message}`);
    m.botError = `Import failed: ${e.message}`;
    m.botStatus = 'call_ended'; // keep polling; retry next tick
  } finally {
    importing.delete(m.id);
    save(m);
  }
}

setInterval(() => {
  if (!RECALL_KEY) return;
  for (const m of meetings.values()) {
    if (m.status === 'bot' && m.botId) pollBot(m).catch((e) => console.error(`bot poll ${m.id}: ${e.message}`));
  }
}, Number(process.env.BOT_POLL_MS) || 15000);

app.get('/api/meetings', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let list = [...meetings.values()];
  if (q) {
    list = list.filter((m) => m.title.toLowerCase().includes(q)
      || m.transcript.some((t) => t.text.toLowerCase().includes(q))
      || (m.summary?.summary || '').toLowerCase().includes(q));
  }
  list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(list.map(listView));
});

app.post('/api/meetings', (req, res) => {
  const m = {
    id: crypto.randomUUID(),
    title: String(req.body.title || '').slice(0, 200) || `Meeting ${new Date().toLocaleString()}`,
    platform: String(req.body.platform || 'other').slice(0, 30),
    createdAt: new Date().toISOString(),
    endedAt: null,
    durationSec: 0,
    status: 'recording',
    hasAudio: false,
    transcript: [],
    summary: null,
  };
  meetings.set(m.id, m);
  save(m);
  res.status(201).json(m);
});

app.get('/api/meetings/:id', wrap((req, res) => res.json(publicMeeting(getMeeting(req)))));

app.patch('/api/meetings/:id', wrap((req, res) => {
  const m = getMeeting(req);
  if (typeof req.body.title === 'string' && req.body.title.trim()) m.title = req.body.title.trim().slice(0, 200);
  save(m);
  res.json(publicMeeting(m));
}));

app.delete('/api/meetings/:id', wrap((req, res) => {
  const m = getMeeting(req);
  meetings.delete(m.id);
  fs.rmSync(dir(m.id), { recursive: true, force: true });
  res.status(204).end();
}));

app.post('/api/meetings/:id/rename-speaker', wrap((req, res) => {
  const m = getMeeting(req);
  const from = String(req.body.from || ''), to = String(req.body.to || '').trim().slice(0, 60);
  if (!from || !to) throw Object.assign(new Error('from and to are required'), { status: 400 });
  for (const t of m.transcript) if (t.speaker === from) t.speaker = to;
  save(m);
  res.json(publicMeeting(m));
}));

// Live audio, uploaded in small chunks while recording so a crash loses seconds, not the meeting.
// The client sends each chunk with its byte offset; the server only appends in order and reports its size,
// which lets the client resend anything that was missed (and makes retries harmless).
app.post('/api/meetings/:id/audio-chunk', express.raw({ type: '*/*', limit: '64mb' }), wrap((req, res) => {
  const m = getMeeting(req);
  const offset = Number(req.query.offset);
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!Number.isInteger(offset) || offset < 0) throw Object.assign(new Error('offset is required'), { status: 400 });
  m.mediaFile = 'audio.webm';
  const have = storedSize(audioPath(m));
  if (offset > have) return res.status(409).json({ error: 'gap', size: have });          // we are missing earlier bytes
  if (offset + body.length <= have) return res.json({ ok: true, size: have, duplicate: true }); // already stored
  const size = appendEncrypted(audioPath(m), body.subarray(have - offset));
  if (!m.hasAudio) { m.hasAudio = true; m.audioPartial = true; save(m); }
  res.json({ ok: true, size });
}));

app.post('/api/meetings/:id/audio-finish', wrap((req, res) => {
  const m = getMeeting(req);
  const size = storedSize(audioPath(m));
  const expected = Number(req.body?.size);
  if (Number.isFinite(expected) && expected !== size) return res.status(409).json({ error: 'size mismatch', size });
  m.hasAudio = size > 0; m.audioPartial = false; m.mediaFile = 'audio.webm';
  save(m);
  res.json({ ok: true, size });
}));

// Stop without a socket (used when the live connection is down at the moment you press Stop).
app.post('/api/meetings/:id/stop', wrap((req, res) => {
  const m = getMeeting(req);
  const duration = Number(req.body?.duration) || 0;
  const S = sessions.get(m.id);
  if (S) S.stop(duration);
  else if (m.status === 'recording') {
    m.status = 'ended'; m.endedAt = new Date().toISOString();
    if (duration) m.durationSec = Math.round(duration);
    save(m);
  }
  res.json({ ok: true });
}));

// Raw audio upload, streamed to disk (recordings can be large).
app.put('/api/meetings/:id/audio', wrap(async (req, res) => {
  const m = getMeeting(req);
  m.mediaFile = 'audio.webm';
  await encryptTo(req, audioPath(m));
  m.hasAudio = true;
  save(m);
  res.json({ ok: true });
}));

app.get('/api/meetings/:id/audio', wrap((req, res) => {
  const m = getMeeting(req);
  const file = audioPath(m);
  if (!m.hasAudio || !fs.existsSync(file)) throw Object.assign(new Error('No audio'), { status: 404 });
  const size = plainSize(file);
  let start = 0, end = size - 1, status = 200;
  const rm = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (rm && (rm[1] || rm[2])) { // Range support so the player can seek inside the decrypted stream
    if (rm[1]) { start = Number(rm[1]); if (rm[2]) end = Math.min(Number(rm[2]), end); }
    else { start = Math.max(0, size - Number(rm[2])); }
    if (start > end || start >= size) { res.status(416).set('Content-Range', `bytes */${size}`); return res.end(); }
    status = 206;
    res.set('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.status(status).set({
    'Content-Type': MIME[path.extname(m.mediaFile || '.webm')] || 'application/octet-stream',
    'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
  });
  const stream = decryptRange(file, start, end);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}));

app.post('/api/meetings/:id/summarize', wrap(async (req, res) => {
  const m = getMeeting(req);
  if (!m.transcript.length) throw Object.assign(new Error('Transcript is empty'), { status: 400 });
  const engine = await getEngine();
  if (!engine) throw Object.assign(new Error(NO_ENGINE), { status: 400 });
  const out = await summarize(engine, m.title, transcriptText(m)).catch((e) => { throw Object.assign(e, { status: 502 }); });
  m.summary = { ...out, engine: `${engine.provider === 'local' ? 'on this device' : 'Claude'}: ${engine.model}`, generatedAt: new Date().toISOString() };
  save(m);
  res.json(publicMeeting(m));
}));

app.post('/api/meetings/:id/ask', wrap(async (req, res) => {
  const m = getMeeting(req);
  const question = String(req.body.question || '').trim().slice(0, 1000);
  if (!question) throw Object.assign(new Error('question is required'), { status: 400 });
  const engine = await getEngine();
  if (!engine) throw Object.assign(new Error(NO_ENGINE), { status: 400 });
  res.json({ answer: await ask(engine, transcriptText(m), question).catch((e) => { throw Object.assign(e, { status: 502 }); }) });
}));

/* ------------------------------------------- speaker corrections & voices */

// Re-label one line ("that was Priya, not Speaker 2"). Manual choices are ground truth and survive re-clustering.
app.post('/api/meetings/:id/segments/:segId/speaker', wrap((req, res) => {
  const m = getMeeting(req);
  const seg = m.transcript.find((t) => String(t.id) === req.params.segId);
  const name = String(req.body.speaker || '').trim().slice(0, 60);
  if (!seg || !name) throw Object.assign(new Error('Segment or speaker not found'), { status: 404 });
  seg.speaker = name; seg.manual = true; seg.uncertain = false;
  save(m);
  res.json(publicMeeting(m));
}));

app.post('/api/meetings/:id/refine', wrap((req, res) => {
  const m = getMeeting(req);
  refineMeeting(m.transcript, { profiles: voiceProfiles() });
  save(m);
  res.json(publicMeeting(m));
}));

app.post('/api/meetings/:id/remember-voice', wrap((req, res) => {
  const m = getMeeting(req);
  const name = String(req.body.speaker || '').trim().slice(0, 60);
  if (!name || /^Speaker \d+$/.test(name) || ['You', 'Others'].includes(name)) {
    throw Object.assign(new Error('Give this speaker a real name first, then remember their voice.'), { status: 400 });
  }
  const vp = voiceprintOf(m.transcript, name);
  if (!vp) throw Object.assign(new Error('Not enough clear speech from this speaker yet (needs at least 2 clear segments of 1 second or more).'), { status: 400 });
  const existing = voices.find((v) => v.name.toLowerCase() === name.toLowerCase());
  if (existing) { // blend with what we already know of this person
    const old = fromB64(existing.emb), mixed = new Float32Array(old.length);
    const wOld = Math.min(existing.n, 60), wNew = vp.n;
    for (let i = 0; i < old.length; i++) mixed[i] = old[i] * wOld + vp.emb[i] * wNew;
    existing.emb = toB64(normalize(mixed)); existing.n = Math.min(60, existing.n + vp.n); existing.updatedAt = new Date().toISOString();
  } else {
    voices.push({ id: crypto.randomUUID(), name, emb: toB64(vp.emb), n: vp.n, updatedAt: new Date().toISOString() });
  }
  saveVoices();
  res.json({ ok: true, voices: voices.map(voiceView) });
}));

app.get('/api/voices', (_req, res) => res.json(voices.map(voiceView)));
app.delete('/api/voices/:id', wrap((req, res) => {
  const i = voices.findIndex((v) => v.id === req.params.id);
  if (i < 0) throw Object.assign(new Error('Voice not found'), { status: 404 });
  voices.splice(i, 1); saveVoices();
  res.json(voices.map(voiceView));
}));
app.delete('/api/voices', (_req, res) => { voices = []; saveVoices(); res.json([]); });

/* --------------------------------------------------------------- websocket */

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/*
 * A recording session lives on the server for as long as the meeting is being recorded, not for as long as one
 * socket stays open. If the browser's connection drops (sleep/wake, network hiccup) the session keeps going and
 * the client simply reconnects to it; the client buffers the audio meanwhile, so nothing is lost or mistimed.
 * Only an explicit Stop, or no reconnection within the grace period, ends it.
 */
const sessions = new Map();
const GRACE_MS = Number(process.env.MR_GRACE_MS) || 120_000;

function createSession(m, { lang, diarizeMic }) {
  const mode = useDeepgram() ? 'deepgram' : 'local';
  const S = { m, mode, sockets: new Set(), stopped: false, interrupted: false, ready: false, tracker: null, timers: [], graceTimer: null, outstanding: 0 };
  let dg = null, dgReady = false;
  const pending = [];
  const segmenters = [];

  const send = (obj) => { const text = JSON.stringify(obj); for (const w of S.sockets) if (w.readyState === WebSocket.OPEN) w.send(text); };
  S.send = send;
  const addSegment = (seg) => {
    m.transcript.push(seg);
    m.transcript.sort((a, b) => a.start - b.start); // local mode finishes utterances slightly out of order
    save(m);                                          // also assigns seg.id
    const { emb, ...visible } = seg;                  // voiceprints never leave the server
    send({ type: 'segment', segment: visible });
  };
  const cleanup = () => {
    S.timers.forEach(clearInterval); S.timers = [];
    clearTimeout(S.graceTimer);
    if (dg && dg.readyState <= WebSocket.OPEN) dg.close(1000);
    sessions.delete(m.id);
  };
  const finalize = () => {
    if (m.status !== 'recording') return cleanup();
    if (S.tracker && m.transcript.some((t) => t.emb)) { // fix early guesses now that every voice has been heard
      try { refineMeeting(m.transcript, { profiles: voiceProfiles() }); } catch (e) { console.error(`speaker refinement failed: ${e.message}`); }
    }
    m.status = 'ended';
    m.endedAt = new Date().toISOString();
    if (S.interrupted) m.interrupted = true;
    if (!m.durationSec) m.durationSec = Math.round((Date.parse(m.endedAt) - Date.parse(m.createdAt)) / 1000);
    save(m);
    cleanup();
  };
  const maybeFinalize = () => { if (S.stopped && S.outstanding === 0) finalize(); };

  /* ---- local mode: two channels (0 = your mic, 1 = everyone else), Whisper on this device ---- */
  if (mode === 'local') {
    const names = ['You', 'Others'];
    let spkOk = speakerOn();
    S.tracker = spkOk ? new SpeakerTracker({ profiles: voiceProfiles() }) : null;
    const spkFailed = (e) => {
      if (!spkOk) return;
      spkOk = false;
      console.error(`[speakers] unavailable: ${e.message}`);
      send({ type: 'error', message: `Speaker recognition is unavailable (${e.message}). Falling back to “You” / “Others” labels.` });
    };
    if (spkOk) spk.ensure().catch(spkFailed);

    // One utterance at a time, in order: split by speaker, then transcribe + fingerprint each piece.
    const handle = async (ch, seg) => {
      const useSpk = spkOk && (ch === 1 || diarizeMic);
      let pieces = [{ start: 0, end: seg.duration, overlap: false }];
      if (useSpk && seg.duration >= 1.2) {
        try { pieces = splitUtterance(await spk.analyze(seg.samples), seg.duration); } catch (e) { spkFailed(e); }
      }
      for (const p of pieces) {
        const x = seg.samples.subarray(Math.round(p.start * 16000), Math.round(p.end * 16000));
        const d = x.length / 16000;
        if (d < 0.4) continue;
        const wantEmb = useSpk && spkOk && d >= 0.5;
        const [text, emb] = await Promise.all([
          stt.transcribe(x, lang, STT_MODEL),
          wantEmb ? spk.embed(x).catch((e) => { spkFailed(e); return null; }) : null,
        ]);
        const drop = isHallucination(text, d);
        if (DEBUG) console.log(`[stt] ch${ch} ${p.start.toFixed(1)}s ${drop ? 'DROPPED ' : ''}${JSON.stringify(text)}`);
        if (drop) continue;
        const base = { start: Math.round((seg.start + p.start) * 10) / 10, dur: Math.round(d * 10) / 10, text };
        if (emb && S.tracker) {
          const noisy = (seg.snr ?? 99) < 10; // speech barely above the room's noise floor: embeddings are less trustworthy
          const a = S.tracker.assign(emb, d, { noisy });
          addSegment({ speaker: a.speaker.name, ...base, emb: toB64(emb), sim: +a.sim.toFixed(3), margin: +a.margin.toFixed(3),
            uncertain: a.uncertain || p.overlap, overlap: a.overlap || p.overlap, ...(p.overlap ? { crosstalk: true } : {}), ...(noisy ? { noisy: true } : {}) });
        } else if (useSpk && spkOk && S.tracker?.last) { // too brief to fingerprint: assume the previous speaker, flagged
          addSegment({ speaker: S.tracker.speakers.find((sp) => sp.id === S.tracker.last)?.name || names[ch], ...base, uncertain: true });
        } else {
          addSegment({ speaker: names[ch], ...base });
        }
      }
    };
    let chain = Promise.resolve();
    for (const ch of [0, 1]) {
      segmenters[ch] = new Segmenter((seg) => {
        S.outstanding++;
        if (DEBUG) console.log(`[stt] ch${ch} utterance ${seg.duration.toFixed(1)}s at ${seg.start.toFixed(1)}s queued`);
        chain = chain.then(() => handle(ch, seg))
          .catch((e) => { console.error(`[stt] transcription failed: ${e.message}`); send({ type: 'error', message: e.message }); })
          .finally(() => { S.outstanding--; maybeFinalize(); });
      });
    }
    stt.ensure(lang, STT_MODEL).then(() => { S.ready = true; send({ type: 'ready' }); }).catch((e) => send({ type: 'error', message: e.message }));
    S.timers.push(setInterval(() => send({ type: 'engine', ...stt.status(), pending: S.outstanding, speaker: spkOk ? spk.status() : null }), 1000));
  }

  /* ---- Deepgram mode (optional, cloud): streaming bridge with speaker labels ---- */
  if (mode === 'deepgram') {
    const qs = new URLSearchParams({
      model: 'nova-3', language: lang, encoding: 'linear16', sample_rate: '16000', channels: '1',
      diarize: 'true', punctuate: 'true', smart_format: 'true', interim_results: 'true', endpointing: '400',
    });
    dg = new WebSocket(`wss://api.deepgram.com/v1/listen?${qs}`, { headers: { Authorization: `Token ${DEEPGRAM_KEY}` } });
    dg.on('open', () => {
      dgReady = true; S.ready = true;
      for (const chunk of pending.splice(0)) dg.send(chunk);
      S.timers.push(setInterval(() => dg.readyState === WebSocket.OPEN && dg.send(JSON.stringify({ type: 'KeepAlive' })), 8000));
      send({ type: 'ready' });
    });
    dg.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== 'Results') return;
      const alt = msg.channel?.alternatives?.[0];
      if (!alt?.transcript) return;
      if (!msg.is_final) return send({ type: 'interim', text: alt.transcript });
      let run = null;
      const runs = [];
      for (const w of alt.words || []) { // split a final result into runs of the same speaker
        const sp = `Speaker ${(w.speaker ?? 0) + 1}`;
        if (!run || run.speaker !== sp) { run = { speaker: sp, start: w.start, words: [] }; runs.push(run); }
        run.words.push(w.punctuated_word || w.word);
      }
      if (!runs.length) runs.push({ speaker: 'Speaker 1', start: msg.start, words: [alt.transcript] });
      for (const r of runs) addSegment({ speaker: r.speaker, start: r.start, text: r.words.join(' ') });
      send({ type: 'interim', text: '' });
    });
    dg.on('error', (e) => send({ type: 'error', message: `Transcription service error: ${e.message}` }));
    dg.on('close', (code) => { if (code !== 1000 && !S.stopped) send({ type: 'error', message: `Transcription service closed (${code}). Check the Deepgram key in Settings.` }); });
  }

  /** Audio from the browser: [channel byte][PCM16 16 kHz] in local mode, raw PCM16 in Deepgram mode. */
  S.push = (data) => {
    if (S.stopped) return;
    if (mode === 'deepgram') { dgReady ? dg.send(data) : pending.push(data); return; }
    if (data.length < 3) return;
    const seg = segmenters[data[0] === 1 ? 1 : 0];
    const u8 = new Uint8Array(data.length - 1); // copy: Int16Array needs an even byte offset
    u8.set(data.subarray(1));
    seg.push(new Int16Array(u8.buffer, 0, u8.length >> 1));
  };

  /** Explicit Stop (or the grace period ran out): flush the last utterance, then finalize once transcription drains. */
  S.stop = (durationSec) => {
    if (S.stopped) return;
    S.stopped = true;
    clearTimeout(S.graceTimer);
    if (durationSec) m.durationSec = Math.round(durationSec);
    if (mode === 'deepgram') {
      if (dg.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: 'CloseStream' })); // let trailing finals arrive
      setTimeout(finalize, 1600);
    } else {
      for (const sgm of segmenters) sgm.flush();
      maybeFinalize();
      setTimeout(finalize, 15 * 60 * 1000); // safety net if the speech engine stalls
    }
  };
  S.lost = () => { S.interrupted = true; S.stop(0); };
  return S;
}

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return ws.close(4003, 'bad origin'); // cross-site socket hijack guard
  const url = new URL(req.url, 'http://localhost');
  const id = url.searchParams.get('meetingId') || '';
  const lang = (url.searchParams.get('lang') || LANGUAGE).replace(/[^a-zA-Z-]/g, '').slice(0, 10);
  const m = ID_RE.test(id) && meetings.get(id);
  if (!m) return ws.close(4004, 'unknown meeting');
  if (m.status !== 'recording') return ws.close(4005, 'meeting already finished');

  let S = sessions.get(m.id);
  const resumed = Boolean(S);
  if (!S) { S = createSession(m, { lang, diarizeMic: url.searchParams.get('room') === '1' }); sessions.set(m.id, S); }
  clearTimeout(S.graceTimer);
  S.sockets.add(ws);
  if (resumed) { // bring a reconnecting page up to date with what was transcribed while it was away
    ws.send(JSON.stringify({ type: 'sync', segments: m.transcript.map(({ emb, ...seg }) => seg) }));
    if (S.ready) ws.send(JSON.stringify({ type: 'ready' }));
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) return S.push(data);
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'stop') { S.stop(Number(msg.duration)); ws.close(1000); }
  });
  ws.on('close', () => {
    S.sockets.delete(ws);
    if (!S.stopped && S.sockets.size === 0) { // connection lost without Stop: wait for the page to come back
      clearTimeout(S.graceTimer);
      S.graceTimer = setTimeout(() => S.lost(), GRACE_MS);
    }
  });
});

export const listening = new Promise((resolve) => server.listen(PORT, HOST, () => {
  const port = server.address().port;
  resolve(port);
  console.log(`Meeting Recorder running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}`);
  console.log(`  storage:       encrypted at rest (key: ${vaultInfo().keySource})`);
  console.log(`  transcription: ${useDeepgram() ? 'Deepgram (cloud)' : `on-device Whisper (${stt.current(LANGUAGE, STT_MODEL).label})`}`);
  console.log(`  meeting bot:   ${useLocalBot() ? 'built-in guest bot (on this device)' : RECALL_KEY ? `Recall.ai (${RECALL_REGION})` : 'unavailable (desktop app has a built-in bot; browser mode needs RECALL_API_KEY)'}`);
  getEngine().then((e) => console.log(`  AI summaries:  ${e ? `${e.provider === 'local' ? 'on-device' : 'Claude'} (${e.model})` : 'none yet - download the summary model in Settings'}`));
}));
