// Bundled language model: no Ollama, no account, no key. The app downloads one open model file (GGUF) sized
// for this computer's memory, checks it against a pinned SHA-256, and runs it with llama.cpp in a child process.
import { fork } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GB = 1024 ** 3;
const IDLE_MS = Number(process.env.MR_LLM_IDLE_MS) || 5 * 60 * 1000; // free the RAM when nobody is summarizing

// Apache-2.0 models from the Qwen3 2507 series (hashes pinned: a tampered or truncated download is rejected).
export const CATALOG = [
  { id: 'qwen3-30b-a3b', label: 'Qwen3 30B-A3B Instruct (best quality)', minRamGB: 24, sizeGB: 18.56, ctx: 16384,
    repo: 'unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF', file: 'Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf',
    sha256: '6c997b8af17debdfb01d890214400ccbab00db6acc0ba8da5de1cc906c4774d0' },
  { id: 'qwen3-4b', label: 'Qwen3 4B Instruct (fast, small)', minRamGB: 6, sizeGB: 2.5, ctx: 16384,
    repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF', file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    sha256: '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597' },
];

/** Best model this computer can run, or null if it has too little memory. */
export const recommendBuiltin = (ramGB = os.totalmem() / GB) => CATALOG.find((m) => ramGB >= m.minRamGB) || null;
const url = (m) => `https://huggingface.co/${m.repo}/resolve/main/${m.file}`;

function engineNode() {
  if (process.env.MR_NODE_BIN) return process.env.MR_NODE_BIN;
  if (process.versions.electron) return 'node';
  return process.execPath;
}

export class BuiltinLLM {
  constructor({ dir }) {
    this.dir = dir;
    this.state = { state: 'idle', progress: 0, error: null }; // idle | downloading | loading | ready | error
    this.child = null; this.loading = null; this.downloading = null;
    this.waiting = new Map(); this.nextId = 1; this.idleTimer = null;
    this.contextSize = 0; this.loadedModel = null;
  }

  /** The recommended model if its file is already on disk and complete, else null. */
  installed() {
    const m = recommendBuiltin();
    // A smaller model that was downloaded earlier is fine too (e.g. user picked it, or RAM changed).
    for (const c of [m, ...CATALOG].filter(Boolean)) if (fs.existsSync(path.join(this.dir, c.file))) return c;
    return null;
  }
  file(m) { return path.join(this.dir, m.file); }
  status() { return { ...this.state, recommended: recommendBuiltin(), installed: this.installed()?.id || null, contextSize: this.contextSize }; }

  /** Download the recommended model (resumable). onDone resolves when verified. */
  download(m = recommendBuiltin()) {
    if (!m) return Promise.reject(new Error('This computer has too little memory (under 6 GB) for the bundled model.'));
    if (this.downloading) return this.downloading;
    this.downloading = (async () => {
      fs.mkdirSync(this.dir, { recursive: true });
      const dest = this.file(m), part = `${dest}.part`;
      if (fs.existsSync(dest)) return m;
      this.state = { state: 'downloading', progress: 0, error: null };
      const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
      const r = await fetch(url(m), { headers: have ? { Range: `bytes=${have}-` } : {} });
      if (!r.ok && r.status !== 206) throw new Error(`Model download failed (${r.status})`);
      const resumed = r.status === 206;
      const total = (resumed ? have : 0) + (Number(r.headers.get('content-length')) || 0) || m.sizeGB * GB;
      const out = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' });
      let got = resumed ? have : 0;
      for await (const chunk of r.body) {
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
        this.state = { state: 'downloading', progress: Math.min(0.99, got / total), error: null };
      }
      await new Promise((res) => out.end(res));
      const hash = crypto.createHash('sha256');
      await new Promise((res, rej) => fs.createReadStream(part).on('data', (d) => hash.update(d)).on('end', res).on('error', rej));
      if (hash.digest('hex') !== m.sha256) { fs.rmSync(part, { force: true }); throw new Error('The downloaded model failed its integrity check and was deleted. Try again.'); }
      fs.renameSync(part, dest);
      this.state = { state: 'idle', progress: 1, error: null };
      return m;
    })().catch((e) => { this.state = { state: 'error', progress: 0, error: e.message }; throw e; })
      .finally(() => { this.downloading = null; });
    return this.downloading;
  }

  _spawn(m) {
    const child = fork(path.join(__dirname, 'llm-worker.js'), [], { execPath: engineNode(), stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    this.child = child;
    child.on('message', (msg) => {
      if (msg.t === 'done') this._settle(msg.id, null, msg.text);
      else if (msg.t === 'error') this._settle(msg.id, new Error(msg.message));
    });
    child.on('exit', () => {
      if (this.child === child) { this.child = null; this.loading = null; this.loadedModel = null; if (this.state.state !== 'error') this.state = { state: 'idle', progress: 0, error: null }; }
      for (const id of [...this.waiting.keys()]) this._settle(id, new Error('The language model stopped (it may have run out of memory).'));
    });
    return child;
  }
  _settle(id, err, val) { const w = this.waiting.get(id); if (!w) return; this.waiting.delete(id); err ? w.reject(err) : w.resolve(val); }

  ensure(m = this.installed()) {
    if (!m) return Promise.reject(new Error('The bundled model has not been downloaded yet.'));
    if (this.loading && this.loadedModel === m.id) return this.loading;
    this.loadedModel = m.id;
    this.loading = new Promise((resolve, reject) => {
      this.state = { state: 'loading', progress: 1, error: null };
      const child = this.child || this._spawn(m);
      const onMsg = (msg) => {
        if (msg.t === 'loaded') { child.off('message', onMsg); this.contextSize = msg.contextSize; this.state = { state: 'ready', progress: 1, error: null }; resolve(); }
        else if (msg.t === 'error' && !msg.id) { child.off('message', onMsg); this.state = { state: 'error', progress: 0, error: msg.message }; this.loading = null; reject(new Error(msg.message)); }
      };
      child.on('message', onMsg);
      child.send({ t: 'load', file: this.file(m), ctx: m.ctx });
    });
    return this.loading;
  }

  async complete(system, user, { json = false, maxTokens = 1500 } = {}) {
    await this.ensure();
    clearTimeout(this.idleTimer);
    const id = this.nextId++;
    try {
      return await new Promise((resolve, reject) => { this.waiting.set(id, { resolve, reject }); this.child.send({ t: 'chat', id, system, user, json, maxTokens }); });
    } finally {
      this.idleTimer = setTimeout(() => this.unload(), IDLE_MS);
      this.idleTimer.unref?.();
    }
  }

  unload() { try { this.child?.kill(); } catch { /* gone */ } }
}
