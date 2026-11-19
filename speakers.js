// Speaker recognition: voiceprint extraction (separate process), online clustering with confidence,
// end-of-meeting refinement, and a library of remembered voices.
//
// Design for messy audio: every decision carries a confidence. A label is only called "certain" when the
// voice matches one speaker clearly better than any other. Cross-talk, very short replies and noisy
// audio produce a small margin between the best and second-best speaker, and those segments are flagged
// "uncertain" (and "overlap" when two known voices both match) instead of being silently mislabelled.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------------------------------------------------------------- vectors */

export const toB64 = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
export const fromB64 = (s) => { const b = Buffer.from(s, 'base64'); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
export const normalize = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return Float32Array.from(v, (x) => x / n); };
export const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
function weightedMean(items) { // items: [{v, w}] of unit vectors
  const out = new Float32Array(items[0].v.length);
  for (const { v, w } of items) for (let i = 0; i < out.length; i++) out[i] += v[i] * w;
  return normalize(out);
}

/* ------------------------------------------------------- model + process */

// TitaNet-small (NVIDIA NeMo) exported for sherpa-onnx. Checksum pinned from the release's checksum.txt.
export const SEGMENTATION_MODEL = { // pyannote segmentation 3.0 (MIT), single-file ONNX export by the sherpa-onnx authors
  file: 'pyannote-segmentation-3-0.onnx',
  url: 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx',
  sha256: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079',
  approxMB: 6,
};

export const SPEAKER_MODEL = {
  file: 'nemo_en_titanet_small.onnx',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx',
  sha256: 'ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e',
  approxMB: 38,
};

function engineNode() {
  if (process.env.MR_NODE_BIN) return process.env.MR_NODE_BIN;
  if (process.versions.electron) return 'node';
  return process.execPath;
}

export class SpeakerEngine {
  constructor({ modelDir }) {
    this.modelDir = modelDir;
    this.child = null;
    this.loading = null;
    this.ready = false;
    this.state = { state: 'idle', progress: 0, error: null };
    this.waiting = new Map();
    this.nextJob = 1;
  }

  status() { return { ...this.state }; }
  modelPath() { return path.join(this.modelDir, SPEAKER_MODEL.file); }
  segModelPath() { return path.join(this.modelDir, SEGMENTATION_MODEL.file); }

  async _download(model, done, total) { // progress covers all models: [done, total] bytes budget
    const dest = path.join(this.modelDir, model.file);
    if (fs.existsSync(dest)) return;
    fs.mkdirSync(this.modelDir, { recursive: true });
    this.state = { state: 'downloading', progress: done / total, error: null };
    const r = await fetch(model.url);
    if (!r.ok || !r.body) throw new Error(`model download failed (${r.status}): ${model.file}`);
    const size = Number(r.headers.get('content-length')) || model.approxMB * 1048576;
    const hash = crypto.createHash('sha256');
    const tmp = `${dest}.part`;
    const out = fs.createWriteStream(tmp);
    let got = 0;
    for await (const chunk of r.body) {
      hash.update(chunk); got += chunk.length;
      if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
      this.state = { ...this.state, progress: Math.min(1, (done + got) / total) };
    }
    await new Promise((res) => out.end(res));
    if (hash.digest('hex') !== model.sha256) { fs.rmSync(tmp, { force: true }); throw new Error(`${model.file} failed its integrity check`); }
    fs.renameSync(tmp, dest);
  }

  /** Download (once), start the process, load the model. Rejects if speaker recognition cannot run here. */
  ensure() {
    if (this.ready) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const total = (SPEAKER_MODEL.approxMB + SEGMENTATION_MODEL.approxMB) * 1048576;
      await this._download(SPEAKER_MODEL, 0, total);
      await this._download(SEGMENTATION_MODEL, SPEAKER_MODEL.approxMB * 1048576, total);
      this.state = { state: 'loading', progress: 1, error: null };
      const child = fork(path.join(__dirname, 'speaker-worker.js'), [], { execPath: engineNode(), stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      this.child = child;
      child.on('message', (m) => this._onMessage(m));
      child.on('exit', (code, sig) => {
        if (this.child === child) { this.child = null; this.ready = false; this.loading = null; }
        const msg = `The speaker engine stopped (${sig || `exit ${code}`}).`;
        for (const w of this.waiting.values()) w.reject(new Error(msg));
        this.waiting.clear();
        if (code !== 0) this.state = { state: 'error', progress: 0, error: msg };
      });
      await new Promise((resolve, reject) => {
        this._onReady = resolve; this._onLoadError = reject;
        child.once('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'Node.js was not found for the speaker engine.' : e.message)));
        child.send({ type: 'load', model: this.modelPath(), segModel: this.segModelPath() });
      });
      this.ready = true;
      this.state = { state: 'ready', progress: 1, error: null };
    })().catch((e) => { this.loading = null; this.state = { state: 'error', progress: 0, error: e.message }; throw e; });
    return this.loading;
  }

  _onMessage(m) {
    if (m.type === 'ready') this._onReady?.();
    else if (m.type === 'turns') { this.waiting.get(m.jobId)?.resolve(m.turns); this.waiting.delete(m.jobId); }
    else if (m.type === 'embedding') { this.waiting.get(m.jobId)?.resolve(normalize(fromB64(m.emb))); this.waiting.delete(m.jobId); }
    else if (m.type === 'error') {
      if (m.phase === 'load') this._onLoadError?.(new Error(m.message));
      else { this.waiting.get(m.jobId)?.reject(new Error(m.message)); this.waiting.delete(m.jobId); }
    }
  }

  /** Voiceprint (unit vector) for Float32 16 kHz audio. */
  async embed(float32) {
    await this.ensure();
    const jobId = this.nextJob++;
    const p = new Promise((resolve, reject) => this.waiting.set(jobId, { resolve, reject }));
    this.child.send({ type: 'embed', jobId, audio: toB64(float32) });
    return p;
  }

  /** Who speaks when inside one utterance: [{ start, end, spk }] with spk local to this clip. */
  async analyze(float32) {
    await this.ensure();
    const jobId = this.nextJob++;
    const p = new Promise((resolve, reject) => this.waiting.set(jobId, { resolve, reject }));
    this.child.send({ type: 'analyze', jobId, audio: toB64(float32) });
    return p;
  }

  dispose() { this.child?.kill(); this.child = null; }
}

/**
 * Cut one utterance into per-speaker pieces using the diarizer's turns. Overlapping speech is cut at the
 * middle of the overlap and both sides are flagged. Tiny pieces are absorbed by a neighbour.
 * Returns [{ start, end, overlap }] in seconds relative to the utterance; one piece = no split.
 */
export function splitUtterance(turns, duration, { minPiece = 0.6 } = {}) {
  const t = [...turns].sort((a, b) => a.start - b.start);
  const whole = [{ start: 0, end: duration, overlap: false }];
  if (t.length < 2 || new Set(t.map((x) => x.spk)).size < 2) return whole;

  // merge consecutive turns of the same speaker (when they do not interleave with someone else)
  const runs = [];
  for (const x of t) {
    const last = runs[runs.length - 1];
    if (last && last.spk === x.spk) last.end = Math.max(last.end, x.end);
    else runs.push({ ...x });
  }
  if (runs.length < 2) return whole;

  const pieces = [];
  for (let i = 0; i < runs.length; i++) {
    const cur = runs[i], next = runs[i + 1], prev = runs[i - 1];
    const start = prev ? Math.min(Math.max(prev.end, 0), cur.start) : 0;
    const overlapNext = next && cur.end > next.start;
    const overlapPrev = prev && prev.end > cur.start;
    const from = prev ? (overlapPrev ? (cur.start + prev.end) / 2 : (prev.end + cur.start) / 2) : 0;
    const to = next ? (overlapNext ? (next.start + cur.end) / 2 : (cur.end + next.start) / 2) : duration;
    pieces.push({ start: Math.max(0, from), end: Math.min(duration, to), overlap: Boolean(overlapNext || overlapPrev) });
    void start;
  }
  // absorb pieces shorter than minPiece into the longer neighbour
  for (let i = 0; i < pieces.length && pieces.length > 1;) {
    if (pieces[i].end - pieces[i].start >= minPiece) { i++; continue; }
    const j = i === 0 ? 1 : i === pieces.length - 1 ? i - 1 : (pieces[i - 1].end - pieces[i - 1].start >= pieces[i + 1].end - pieces[i + 1].start ? i - 1 : i + 1);
    const a = Math.min(i, j), b = Math.max(i, j);
    pieces.splice(a, 2, { start: pieces[a].start, end: pieces[b].end, overlap: pieces[a].overlap || pieces[b].overlap });
    i = Math.max(0, a);
  }
  return pieces.length > 1 ? pieces : whole;
}

/* ------------------------------------------------------------ the tracker */

// Cosine thresholds measured with TitaNet-small: same voice averaged 0.79 (lowest 0.38); different voices
// averaged 0.22 (highest 0.64). When the model is right the best speaker leads by ~0.4; when it is wrong
// (cross-talk, noise) the lead is ~0.03, which is what the margin test below catches.
// Measured confusable pairs (two similar-sounding voices) reach ~0.64, so the live thresholds sit above that
// and bias toward SPLITTING: an extra "Speaker 5" is easy to merge later, a wrongly merged person is not.
export const TUNING = { match: 0.72, fresh: 0.62, margin: 0.12, minVoiceSec: 1.0, overlapSecond: 0.4, merge: 0.72 };

export class SpeakerTracker {
  /** profiles: [{ id, name, emb(Float32 unit), n }] remembered voices, matched by name. */
  constructor({ profiles = [], tuning = {} } = {}) {
    this.t = { ...TUNING, ...tuning };
    this.speakers = profiles.map((p) => ({ id: `p:${p.id}`, name: p.name, profile: true, centroid: normalize(p.emb), n: Math.max(1, p.n || 1) }));
    this.counter = 0;
    this.last = null; // last speaker id: used for very short utterances
  }

  _fresh() {
    this.counter++;
    const s = { id: `s${this.counter}`, name: `Speaker ${this.counter}`, profile: false, centroid: null, n: 0 };
    this.speakers.push(s);
    return s;
  }

  /** Assign one utterance. Returns { speaker, sim, margin, uncertain, overlap }. */
  assign(emb, durationSec, { noisy = false } = {}) {
    const ranked = this.speakers.filter((s) => s.centroid).map((s) => ({ s, sim: cosine(emb, s.centroid) })).sort((a, b) => b.sim - a.sim);
    const best = ranked[0], second = ranked[1];
    const margin = best ? best.sim - (second ? second.sim : 0) : 1;
    const short = durationSec < this.t.minVoiceSec;
    const overlap = Boolean(best && second && best.sim >= this.t.overlapSecond && second.sim >= this.t.overlapSecond && margin < this.t.margin);

    let pick, uncertain = false;
    if (!best || best.sim < this.t.fresh) {
      if (short && this.last) { pick = this.speakers.find((s) => s.id === this.last); uncertain = true; } // too brief to be a new person
      else { pick = this._fresh(); uncertain = noisy; } // a new voice heard only through noise is a guess
    } else if (best.sim >= this.t.match && margin >= this.t.margin) {
      pick = best.s;
    } else {
      pick = best.s; uncertain = true; // between "same" and "new", or two speakers both plausible
    }
    if (short || noisy) uncertain = true;

    // Only clear, long-enough utterances move a speaker's voiceprint, so noise cannot drag it off.
    if (!uncertain && !overlap) {
      if (!pick.centroid) { pick.centroid = emb; pick.n = 1; }
      else {
        const w = Math.min(pick.n, 30); // cap so one voice stays adaptive but stable
        pick.centroid = weightedMean([{ v: pick.centroid, w }, { v: emb, w: 1 }]); pick.n++;
      }
    } else if (!pick.centroid) { pick.centroid = emb; pick.n = 1; }
    this.last = pick.id;
    return { speaker: pick, sim: best ? best.sim : 0, margin, uncertain, overlap };
  }
}

/* ------------------------------------------------- end-of-meeting refine */

/**
 * Re-cluster a finished meeting. Early utterances were labelled before the app had heard enough of each
 * voice; this merges duplicate speakers and re-assigns every segment against the final voiceprints.
 * segments: [{ speaker, emb(b64), dur, manual? }]; profiles as for SpeakerTracker.
 * Mutates the segments (speaker, uncertain, overlap, sim, margin) and returns the speaker names in order.
 */
export function refineMeeting(segments, { profiles = [], tuning = {} } = {}) {
  const t = { ...TUNING, ...tuning };
  const items = segments.map((seg) => ({ seg, v: seg.emb ? normalize(fromB64(seg.emb)) : null })).filter((x) => x.v);
  if (items.length < 2) return [];

  // 1. Start from the live labels' centroids (manual corrections included, they are ground truth).
  const byName = new Map();
  for (const it of items) {
    const k = it.seg.speaker;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push({ v: it.v, w: Math.min(3, Math.max(0.3, it.seg.dur || 1)) * (it.seg.uncertain && !it.seg.manual ? 0.3 : 1) });
  }
  let clusters = [...byName.entries()].map(([name, vs]) => ({ name, centroid: weightedMean(vs), locked: vs.length === 0 }));
  for (const p of profiles) { // remembered voices are always clusters under their own name
    const c = clusters.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
    if (c) c.centroid = weightedMean([{ v: c.centroid, w: 1 }, { v: normalize(p.emb), w: 1 }]);
    else clusters.push({ name: p.name, centroid: normalize(p.emb), locked: true });
  }

  // 2. Merge near-duplicate generic speakers ("Speaker 3" is really "Speaker 1").
  const generic = (c) => /^Speaker \d+$/.test(c.name);
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
      const a = clusters[i], b = clusters[j];
      if (!(generic(a) || generic(b))) continue; // never auto-merge two named people
      if (cosine(a.centroid, b.centroid) >= t.merge) {
        const keep = generic(a) && !generic(b) ? b : a, drop = keep === a ? b : a;
        keep.centroid = weightedMean([{ v: a.centroid, w: 1 }, { v: b.centroid, w: 1 }]);
        for (const it of items) if (it.seg.speaker === drop.name && !it.seg.manual) it.seg.speaker = keep.name;
        clusters = clusters.filter((c) => c !== drop); merged = true; break outer;
      }
    }
  }

  // 3. Re-assign every non-manual segment to the nearest final voiceprint, then recompute confidence.
  for (let pass = 0; pass < 2; pass++) {
    for (const it of items) {
      const ranked = clusters.map((c) => ({ c, sim: cosine(it.v, c.centroid) })).sort((a, b) => b.sim - a.sim);
      const best = ranked[0], second = ranked[1];
      const margin = best.sim - (second ? second.sim : 0);
      const short = (it.seg.dur || 0) < t.minVoiceSec;
      it.seg.sim = +best.sim.toFixed(3); it.seg.margin = +margin.toFixed(3);
      // "crosstalk" is the segmenter's own finding that people spoke at once; it survives re-clustering.
      it.seg.overlap = Boolean(it.seg.crosstalk || (second && best.sim >= t.overlapSecond && second.sim >= t.overlapSecond && margin < t.margin));
      if (it.seg.manual) { it.seg.uncertain = false; continue; }
      it.seg.speaker = best.c.name;
      it.seg.uncertain = Boolean(it.seg.crosstalk) || short || best.sim < t.match || margin < t.margin;
    }
    for (const c of clusters) { // refresh centroids from confident segments only
      const vs = items.filter((it) => it.seg.speaker === c.name && !it.seg.uncertain).map((it) => ({ v: it.v, w: Math.min(3, it.seg.dur || 1) }));
      if (vs.length) c.centroid = weightedMean(vs);
    }
  }

  // 4. Tiny clusters (one stray utterance) are noise, not people: fold them into the nearest voice, flagged.
  for (const c of [...clusters]) {
    if (!generic(c)) continue;
    const mine = items.filter((it) => it.seg.speaker === c.name);
    const secs = mine.reduce((s, it) => s + (it.seg.dur || 0), 0);
    if (mine.length <= 1 && clusters.length > 1) {
      const others = clusters.filter((o) => o !== c);
      const near = mine.length ? others.map((o) => ({ o, sim: cosine(mine[0].v, o.centroid) })).sort((a, b) => b.sim - a.sim)[0] : null;
      // a lone short utterance, or a lone one that is vaguely like someone known (noise?), is not a new person
      if (!near || secs < 3 || mine[0].seg.noisy) { // too little evidence, or only heard through noise
        for (const it of mine) { if (it.seg.manual) continue; it.seg.speaker = near.o.name; it.seg.uncertain = true; }
        clusters = clusters.filter((x) => x !== c);
      }
    }
  }

  // 5. Number generic speakers in order of first appearance.
  const order = [];
  for (const seg of segments) if (!order.includes(seg.speaker)) order.push(seg.speaker);
  const renames = new Map(); let k = 0;
  for (const name of order) if (/^Speaker \d+$/.test(name)) renames.set(name, `Speaker ${++k}`);
  for (const seg of segments) if (renames.has(seg.speaker)) seg.speaker = renames.get(seg.speaker);
  return order.map((n) => renames.get(n) || n);
}

/* ---------------------------------------------------------------- stats */

/** Per-speaker characterization of a transcript: how much, how often, how sure. */
export function speakerStats(transcript) {
  const by = new Map();
  let total = 0;
  for (const s of transcript) {
    const e = by.get(s.speaker) || { name: s.speaker, talkSec: 0, words: 0, turns: 0, uncertain: 0, firstAt: s.start };
    const dur = s.dur || Math.max(1, (s.text || '').split(/\s+/).length / 2.5); // bot/old meetings have no duration: estimate
    e.talkSec += dur; e.words += (s.text || '').split(/\s+/).filter(Boolean).length; e.turns++;
    if (s.uncertain) e.uncertain++;
    by.set(s.speaker, e); total += dur;
  }
  return [...by.values()].sort((a, b) => a.firstAt - b.firstAt).map((e) => ({
    ...e, talkSec: Math.round(e.talkSec), share: total ? +(e.talkSec / total).toFixed(3) : 0,
    wordsPerTurn: e.turns ? Math.round(e.words / e.turns) : 0,
  }));
}

/** Average voiceprint of a speaker's confident segments in one meeting (for "remember this voice"). */
export function voiceprintOf(transcript, name) {
  const vs = transcript.filter((s) => s.speaker === name && s.emb && !s.uncertain && !s.overlap && (s.dur || 0) >= 1)
    .map((s) => ({ v: normalize(fromB64(s.emb)), w: Math.min(3, s.dur || 1) }));
  return vs.length >= 2 ? { emb: weightedMean(vs), n: vs.length } : null;
}
