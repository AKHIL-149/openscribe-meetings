// On-device speech-to-text: hardware detection, automatic Whisper model choice, and a speech
// segmenter that cuts a live audio stream into utterances on pauses.
import os from 'os';
import path from 'path';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function hardware() {
  return {
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model?.trim() || 'unknown CPU',
    cores: os.cpus().length,
    ramGB: Math.round(os.totalmem() / 2 ** 30),
    appleSilicon: process.platform === 'darwin' && process.arch === 'arm64',
  };
}

/* ------------------------------------------------------------ model choice */

// Best quality first. Speeds below were measured on an M1 Max (10 cores): turbo ~0.4x real time,
// small ~0.2x, base ~0.1x, tiny ~0.05x. The ladder starts at the best tier the machine should keep
// up with, and the transcriber steps further down on its own if it falls behind during a call.
const TIERS = [
  { tier: 'turbo', label: 'Whisper large-v3-turbo (best accuracy)', approxMB: 900, multi: 'onnx-community/whisper-large-v3-turbo' },
  { tier: 'small', label: 'Whisper small', approxMB: 250, en: 'Xenova/whisper-small.en', multi: 'Xenova/whisper-small' },
  { tier: 'base', label: 'Whisper base', approxMB: 80, en: 'Xenova/whisper-base.en', multi: 'Xenova/whisper-base' },
  { tier: 'tiny', label: 'Whisper tiny (fastest)', approxMB: 40, en: 'Xenova/whisper-tiny.en', multi: 'Xenova/whisper-tiny' },
];

export function sttLadder(lang = 'en', hw = hardware()) {
  let start;
  if (hw.ramGB >= 16 && ((hw.appleSilicon && hw.cores >= 8) || hw.cores >= 12)) start = 0;
  else if (hw.ramGB >= 8 && hw.cores >= 6) start = 1;
  else if (hw.cores >= 4) start = 2;
  else start = 3;
  const english = /^en(-|$)/i.test(lang);
  return TIERS.slice(start).map((t) => ({
    tier: t.tier, label: t.label, approxMB: t.approxMB,
    id: english && t.en ? t.en : t.multi,
    multilingual: !(english && t.en),
  }));
}

/* ------------------------------------------------------- Whisper manager */

/** The Node.js binary used for the speech engine. */
function engineNode() {
  if (process.env.MR_NODE_BIN) return process.env.MR_NODE_BIN;
  if (process.versions.electron) return 'node'; // running unpackaged inside Electron: use Node from PATH
  return process.execPath;
}

export class LocalSTT {
  constructor({ cacheDir }) {
    this.cacheDir = cacheDir;
    this.worker = null;
    this.state = { state: 'idle', model: null, tier: null, progress: 0, error: null, downgraded: false };
    this.offset = 0;               // steps down the ladder (auto-downgrade)
    this.loaded = null;            // key of the loaded model
    this.loading = null;
    this.queue = [];
    this.running = false;
    this.nextJob = 1;
    this.waiting = new Map();      // jobId -> {resolve,reject}
    this.lags = [];
    this.files = new Map();
  }

  status() { return { ...this.state }; }

  current(lang, override) {
    const ladder = sttLadder(lang);
    if (override && override !== 'auto') {
      const hit = ladder.find((t) => t.tier === override) || sttLadder(lang, { ramGB: 99, cores: 99, appleSilicon: true }).find((t) => t.tier === override);
      if (hit) return hit;
    }
    return ladder[Math.min(this.offset, ladder.length - 1)];
  }

  _spawn() {
    if (this.worker) return;
    // A separate process running a real Node.js. ONNX Runtime cannot run inside Electron's own runtime
    // (it crashes), so the desktop app bundles Node and passes its path in MR_NODE_BIN.
    const child = fork(path.join(__dirname, 'local-worker.js'), [], {
      execPath: engineNode(),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    this.worker = child;
    child.on('message', (m) => this._onMessage(m));
    child.on('error', (e) => this._fail(e.code === 'ENOENT'
      ? 'The speech engine could not start (Node.js was not found).'
      : `Speech engine failed to start: ${e.message}`));
    child.on('exit', (code, sig) => {
      if (this.worker === child) { this.worker = null; this.loaded = null; this.loading = null; }
      if (code !== 0 && code !== null) this._fail(`The speech engine stopped unexpectedly (${sig || `exit ${code}`}). It will restart on the next recording.`);
      else if (sig) this._fail(`The speech engine stopped unexpectedly (${sig}). It will restart on the next recording.`);
    });
  }

  _fail(message) {
    this.state = { ...this.state, state: 'error', error: message };
    for (const w of this.waiting.values()) w.reject(new Error(message));
    this.waiting.clear();
  }

  _onMessage(m) {
    if (m.type === 'progress') {
      const p = m.p || {};
      if (p.file && p.total) {
        this.files.set(p.file, { loaded: p.loaded || 0, total: p.total });
        let l = 0, t = 0;
        for (const f of this.files.values()) { l += f.loaded; t += f.total; }
        this.state = { ...this.state, state: 'downloading', progress: t ? l / t : 0 };
      }
    } else if (m.type === 'ready') {
      this.state = { ...this.state, state: 'ready', progress: 1, error: null };
      this._ready?.();
    } else if (m.type === 'result') {
      this.waiting.get(m.jobId)?.resolve(m); this.waiting.delete(m.jobId);
    } else if (m.type === 'error') {
      if (m.phase === 'load') { this._fail(`Could not load the speech model: ${m.message}`); this._readyFail?.(new Error(m.message)); }
      else { this.waiting.get(m.jobId)?.reject(new Error(m.message)); this.waiting.delete(m.jobId); }
    }
  }

  /** Make sure the right model is downloaded and loaded. Safe to call repeatedly. */
  ensure(lang = 'en', override = 'auto') {
    if (process.platform === 'darwin' && process.arch === 'x64') { // no native ONNX Runtime build exists for Intel Macs
      const msg = 'On-device transcription is not available on Intel Macs. Use Apple Silicon or Windows, or switch to Deepgram in Settings.';
      this.state = { ...this.state, state: 'error', error: msg };
      return Promise.reject(new Error(msg));
    }
    const pick = this.current(lang, override);
    const key = `${pick.id}`;
    if (this.loaded === key) return Promise.resolve(pick);
    if (this.loading?.key === key) return this.loading.promise;
    this._spawn();
    this.files.clear();
    this.state = { state: 'loading', model: pick.id, tier: pick.tier, label: pick.label, progress: 0, error: null, downgraded: this.offset > 0 };
    const promise = new Promise((resolve, reject) => {
      this._ready = () => { this.loaded = key; this.loading = null; resolve(pick); };
      this._readyFail = (e) => { this.loading = null; reject(e); };
    });
    this.loading = { key, promise };
    this.worker.send({ type: 'load', id: pick.id, dtype: 'q8', multilingual: pick.multilingual, cacheDir: this.cacheDir });
    return promise;
  }

  /** Queue audio (Float32, 16 kHz) for transcription. Resolves with the text. */
  transcribe(float32, lang = 'en', override = 'auto') {
    return new Promise((resolve, reject) => {
      this.queue.push({ float32, lang, override, resolve, reject, queuedAt: Date.now() });
      this._pump();
    });
  }

  pending() { return this.queue.length + (this.running ? 1 : 0); }

  async _pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        try {
          await this.ensure(job.lang, job.override);
          const lag = (Date.now() - job.queuedAt) / 1000;
          const jobId = this.nextJob++;
          const done = new Promise((res, rej) => this.waiting.set(jobId, { resolve: res, reject: rej }));
          // JSON IPC (not V8 'advanced' serialization): the app's V8 and the bundled Node's V8 differ.
          const f = job.float32;
          this.worker.send({ type: 'run', jobId, audio: Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64'), lang: job.lang });
          const r = await done;
          this._trackLag(lag, job);
          job.resolve(r.text);
        } catch (e) { job.reject(e); }
      }
    } finally { this.running = false; }
  }

  // If utterances sit in the queue for a long time, the model is too heavy for this machine right now:
  // step down one tier (reloaded before the next job).
  _trackLag(lag, job) {
    this.lags.push(lag);
    if (this.lags.length > 3) this.lags.shift();
    if (job.override && job.override !== 'auto') return;
    const ladder = sttLadder(job.lang);
    if (this.lags.length >= 3 && this.lags.every((l) => l > 6) && this.offset < ladder.length - 1) {
      this.offset++;
      this.lags = [];
      this.state = { ...this.state, downgraded: true };
    }
  }

  dispose() { this.worker?.kill(); this.worker = null; }
}

/* ------------------------------------------------------ speech segmenter */

/**
 * Feeds on 16 kHz PCM16 chunks and calls onSegment({ start, samples: Float32Array }) after each
 * utterance (speech followed by ~0.8 s of quiet, or 25 s of continuous speech).
 */
export class Segmenter {
  constructor(onSegment) {
    this.onSegment = onSegment;
    this.t = 0;                // seconds of audio seen
    this.floor = 0.005;        // adaptive noise floor (RMS)
    this.active = false;
    this.cur = [];
    this.curDur = 0;
    this.speechDur = 0;
    this.silence = 0;
    this.start = 0;
    this.spSq = 0;             // speech energy, for a signal-to-noise estimate
    this.spN = 0;
    this.pre = [];             // short pre-roll so word onsets are not clipped
    this.preDur = 0;
  }

  push(buf) {
    const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
    if (!pcm.length) return;
    const dur = pcm.length / 16000;
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) { const v = pcm[i] / 32768; sum += v * v; }
    const rms = Math.sqrt(sum / pcm.length);
    const speech = rms > Math.max(0.012, this.floor * 2.5);
    const chunk = Int16Array.from(pcm);

    if (speech) {
      if (!this.active) {
        this.active = true;
        this.start = Math.max(0, this.t - this.preDur);
        this.cur = [...this.pre]; this.curDur = this.preDur; this.speechDur = 0; this.silence = 0; this.spSq = 0; this.spN = 0;
        this.pre = []; this.preDur = 0;
      }
      this.cur.push(chunk); this.curDur += dur; this.speechDur += dur; this.silence = 0; this.spSq += sum; this.spN += pcm.length;
    } else {
      this.floor = Math.min(0.05, Math.max(0.002, this.floor * 0.95 + rms * 0.05));
      if (this.active) {
        this.cur.push(chunk); this.curDur += dur; this.silence += dur;
        if (this.silence >= 0.8) this.finish();
      } else {
        this.pre.push(chunk); this.preDur += dur;
        while (this.preDur > 0.3 && this.pre.length > 1) this.preDur -= this.pre.shift().length / 16000;
      }
    }
    if (this.active && this.curDur >= 25) this.finish();
    this.t += dur;
  }

  finish() {
    if (this.active && this.speechDur >= 0.4) {
      let n = 0; for (const c of this.cur) n += c.length;
      const f = new Float32Array(n); let o = 0;
      for (const c of this.cur) for (let i = 0; i < c.length; i++) f[o++] = c[i] / 32768;
      const speechRms = Math.sqrt(this.spSq / Math.max(1, this.spN));
      const snr = 20 * Math.log10(Math.max(speechRms, 1e-5) / Math.max(this.floor, 1e-4)); // dB, speech vs the pauses' noise floor
      this.onSegment({ start: this.start, samples: f, duration: this.curDur, snr });
    }
    this.active = false; this.cur = []; this.curDur = 0; this.speechDur = 0; this.silence = 0;
  }

  flush() { this.finish(); }
}

const JUNK = new Set(['you', 'thank you', 'thanks', 'thanks for watching', 'bye', 'okay', 'so', 'the', 'uh', 'um']);
/** Whisper invents text on near-silence ("Thank you.", "[BLANK_AUDIO]"); drop those. */
export function isHallucination(text, duration) {
  const t = text.trim();
  if (!t) return true;
  if (/^[\[(*♪].*[\])*♪]$/.test(t)) return true; // [BLANK_AUDIO], (music), ♪
  const norm = t.toLowerCase().replace(/[^a-z ]/g, '').trim();
  return duration < 2.5 && JUNK.has(norm);
}
