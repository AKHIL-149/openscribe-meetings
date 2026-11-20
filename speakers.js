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
const OVERLAP_MIN_SEC = 0.3;
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
    // Real recordings give jittery turn boundaries: only count people talking over each other when it lasts a moment.
    const overlapNext = next && cur.end - next.start >= OVERLAP_MIN_SEC;
    const overlapPrev = prev && prev.end - cur.start >= OVERLAP_MIN_SEC;
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

  /** Adopt the voices found by a mid-meeting cleanup, so later lines continue with the same names. */
  reseed(clusters) {
    const keep = this.speakers.filter((s) => s.profile);
    this.speakers = [...keep, ...clusters.filter((c) => !keep.some((k) => k.name === c.name)).map((c, i) => ({ id: `r${i}`, name: c.name, profile: false, centroid: c.centroid, n: 8 }))];
    this.counter = Math.max(0, ...this.speakers.map((s) => Number((/^Speaker (\d+)$/.exec(s.name) || [])[1]) || 0));
    this.last = null; // ids were rebuilt: the old "last speaker" no longer exists
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
      const prev = short && this.last ? this.speakers.find((s) => s.id === this.last) : null;
      if (prev) { pick = prev; uncertain = true; } // too brief to be a new person
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

const MIN_PERSON_SEC = 8; // ...and at least this many seconds of clear speech
const SIGNIFICANT = 0.04; // a "person" holds at least this share of the speech; smaller groups are noise fragments

/**
 * Cluster the clear utterances with average-free centroid linkage and decide HOW MANY people there are from the
 * data instead of a fixed similarity threshold (real recordings score much lower than clean ones, so any fixed
 * threshold is wrong for one of them). The number of "significant" clusters (>= 4% of the speech) is tracked
 * as clusters merge; the cut is made where that number is most stable (the widest plateau, preferring more
 * speakers, because a wrongly split voice is easy to fix and a wrongly merged pair is not).
 * items: [{ v (unit vector), w (weight) }]. Returns clusters [{ idx: number[], centroid }] of significant groups.
 */
function significantClusters(items) {
  let pool = items;
  if (pool.length > 700) pool = [...items].sort((a, b) => b.w - a.w).slice(0, 700); // keep the O(n^2) matrix small on very long meetings
  const n = pool.length, dim = pool[0].v.length, total = pool.reduce((s, x) => s + x.w, 0);
  if (n < 3) return [];
  const sum = pool.map((x) => Float32Array.from(x.v, (c) => c * x.w)), mass = pool.map((x) => x.w), members = pool.map((_, i) => [i]);
  const unit = (v) => { let m = 0; for (let i = 0; i < dim; i++) m += v[i] * v[i]; m = Math.sqrt(m) || 1; return Float32Array.from(v, (c) => c / m); };
  const cen = pool.map((x) => Float32Array.from(x.v));
  const sim = new Float32Array(n * n).fill(-2);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) sim[i * n + j] = cosine(cen[i], cen[j]);
  const alive = new Array(n).fill(true);
  let sig = 0; const levels = []; // after each merge: the similarity it happened at, and how many significant clusters exist
  const minMass = Math.max(SIGNIFICANT * total, MIN_PERSON_SEC); // also an absolute floor, so a short meeting cannot invent people
  const isSig = (i) => mass[i] >= minMass;
  for (let step = 0; step < n - 1; step++) {
    let bi = -1, bj = -1, bs = -3;
    for (let i = 0; i < n; i++) { if (!alive[i]) continue; for (let j = i + 1; j < n; j++) if (alive[j] && sim[i * n + j] > bs) { bs = sim[i * n + j]; bi = i; bj = j; } }
    if (bi < 0) break;
    if (isSig(bi)) sig--; if (isSig(bj)) sig--;
    for (let k = 0; k < dim; k++) sum[bi][k] += sum[bj][k];
    mass[bi] += mass[bj]; members[bi].push(...members[bj]); alive[bj] = false; cen[bi] = unit(sum[bi]);
    if (isSig(bi)) sig++;
    for (let k = 0; k < n; k++) if (alive[k] && k !== bi) sim[Math.min(k, bi) * n + Math.max(k, bi)] = cosine(cen[k], cen[bi]);
    levels.push({ sim: bs, sig });
  }
  // Plateaus: runs of consecutive merges with the same significant-cluster count.
  const plateaus = [];
  for (let i = 0; i < levels.length;) {
    let j = i; while (j + 1 < levels.length && levels[j + 1].sig === levels[i].sig) j++;
    plateaus.push({ sig: levels[i].sig, from: i, to: j, width: levels[i].sim - levels[j].sim }); i = j + 1;
  }
  if (process.env.MR_DEBUG_SPK) console.error('[spk] plateaus', plateaus.map((p) => `K${p.sig}:w${p.width.toFixed(2)}`).join(' '));
  const solid = plateaus.filter((p) => p.sig >= 1 && p.width >= 0.05);
  const pick = (solid.length ? solid : plateaus.filter((p) => p.sig >= 1)).sort((a, b) => b.sig - a.sig || b.width - a.width)[0];
  if (!pick) return [];
  // Replay the merges up to the end of the chosen plateau.
  const m2 = pool.map((_, i) => [i]), s2 = pool.map((x) => Float32Array.from(x.v, (c) => c * x.w)), a2 = new Array(n).fill(true), c2 = pool.map((x) => Float32Array.from(x.v));
  const sm = new Float32Array(sim.length).fill(-2);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) sm[i * n + j] = cosine(c2[i], c2[j]);
  for (let step = 0; step <= pick.to; step++) {
    let bi = -1, bj = -1, bs = -3;
    for (let i = 0; i < n; i++) { if (!a2[i]) continue; for (let j = i + 1; j < n; j++) if (a2[j] && sm[i * n + j] > bs) { bs = sm[i * n + j]; bi = i; bj = j; } }
    for (let k = 0; k < dim; k++) s2[bi][k] += s2[bj][k];
    m2[bi].push(...m2[bj]); a2[bj] = false; c2[bi] = unit(s2[bi]);
    for (let k = 0; k < n; k++) if (a2[k] && k !== bi) sm[Math.min(k, bi) * n + Math.max(k, bi)] = cosine(c2[k], c2[bi]);
  }
  const out = [];
  for (let i = 0; i < n; i++) if (a2[i] && m2[i].reduce((s, k) => s + pool[k].w, 0) >= minMass) out.push({ idx: m2[i].map((k) => pool[k]), centroid: c2[i] });
  return out;
}

/**
 * Re-cluster a finished meeting. Early utterances were labelled before the app had heard enough of each
 * voice, and on real recordings the live tracker over-splits. This groups the clear utterances, works out
 * how many people there really are, and re-assigns every segment to the nearest of those voices.
 * segments: [{ speaker, emb(b64), dur, manual? }]; profiles as for SpeakerTracker.
 * Mutates the segments (speaker, uncertain, overlap, sim, margin) and returns the speaker names in order.
 */
export function refineMeeting(segments, { profiles = [], tuning = {} } = {}) {
  const t = { ...TUNING, ...tuning };
  const items = segments.map((seg) => ({ seg, v: seg.emb ? normalize(fromB64(seg.emb)) : null })).filter((x) => x.v);
  if (items.length < 2) return [];
  const generic = (name) => /^Speaker \d+$/.test(name);
  // "Noisy" is relative to this recording: a room mic that is ~12 dB everywhere is normal, a line 3 dB below that is not.
  const snrs = segments.map((s) => s.snr).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const medSnr = snrs.length ? snrs[Math.floor(snrs.length / 2)] : null;
  const noisyLine = (seg) => (Number.isFinite(seg.snr) && medSnr !== null ? seg.snr < Math.min(10, medSnr - 3) : Boolean(seg.noisy));
  const clear = (it) => (it.seg.dur || 0) >= 1.5 && !it.seg.crosstalk && !noisyLine(it.seg);

  // 1. Seeds: people who already have a real name (remembered voices, manual corrections) are ground truth.
  let clusters = [];
  const named = new Map();
  for (const it of items) if (!generic(it.seg.speaker)) { if (!named.has(it.seg.speaker)) named.set(it.seg.speaker, []); named.get(it.seg.speaker).push({ v: it.v, w: Math.min(3, it.seg.dur || 1) }); }
  for (const [name, vs] of named) clusters.push({ name, centroid: weightedMean(vs) });
  for (const p of profiles) {
    const c = clusters.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
    if (c) c.centroid = weightedMean([{ v: c.centroid, w: 1 }, { v: normalize(p.emb), w: 1 }]);
    else clusters.push({ name: p.name, centroid: normalize(p.emb) });
  }

  // 2. Find the people among the clear, unnamed utterances; the count comes from the data.
  const pool = items.filter((it) => generic(it.seg.speaker) && clear(it) && !it.seg.manual).map((it) => ({ v: it.v, w: Math.min(6, it.seg.dur || 1), it }));
  const found = significantClusters(pool);
  let k = 0;
  const seeds = [...clusters]; // only remembered/named voices can absorb a found group
  for (const f of found) {
    const near = seeds.map((c) => ({ c, sim: cosine(f.centroid, c.centroid) })).sort((a, b) => b.sim - a.sim)[0];
    if (near && near.sim >= t.merge) near.c.centroid = weightedMean([{ v: near.c.centroid, w: 1 }, { v: f.centroid, w: 1 }]); // same as a remembered voice
    else clusters.push({ name: `Speaker ${++k}`, centroid: f.centroid });
  }
  if (!clusters.length) return [];

  // 3. Assign every non-manual segment to its nearest voice (two passes so centroids settle).
  const sims = [];
  for (let pass = 0; pass < 2; pass++) {
    sims.length = 0;
    for (const it of items) {
      const ranked = clusters.map((c) => ({ c, sim: cosine(it.v, c.centroid) })).sort((a, b) => b.sim - a.sim);
      const best = ranked[0], second = ranked[1];
      const margin = best.sim - (second ? second.sim : 0);
      it.best = best.sim; it.margin = margin; it.second = second ? second.sim : -1;
      it.seg.sim = +best.sim.toFixed(3); it.seg.margin = +margin.toFixed(3);
      if (it.seg.manual) continue;
      it.seg.speaker = best.c.name;
      if (clear(it)) sims.push(best.sim);
    }
    for (const c of clusters) { // refresh centroids from the clear segments assigned to each voice
      const vs = items.filter((it) => it.seg.speaker === c.name && clear(it) && !it.seg.manual).map((it) => ({ v: it.v, w: Math.min(3, it.seg.dur || 1) }));
      if (vs.length >= 2) c.centroid = weightedMean(vs);
    }
  }

  // 4. Confidence is relative to how well this meeting's own clear utterances fit their speaker (real audio scores
  //    lower than clean audio), plus the margin to the runner-up. Short, noisy and crosstalk lines are always flagged.
  sims.sort((a, b) => a - b);
  const floor = sims.length ? Math.max(0.2, sims[Math.floor(sims.length * 0.1)]) : 0.3;
  for (const it of items) {
    // The overlap detector is only a hint on real audio (jittery turn boundaries): it counts when the voice itself is ambiguous too.
    const ambiguous = it.margin < t.margin;
    it.seg.overlap = Boolean((it.seg.crosstalk && ambiguous) || (it.second >= t.overlapSecond && it.best >= t.overlapSecond && it.margin < 0.05));
    if (it.seg.manual) { it.seg.uncertain = false; continue; }
    const noisy = noisyLine(it.seg);
    if (it.seg.noisy !== undefined || noisy) { if (noisy) it.seg.noisy = true; else delete it.seg.noisy; }
    it.seg.uncertain = Boolean(it.seg.crosstalk && ambiguous) || (it.seg.dur || 0) < t.minVoiceSec || noisy || it.best < floor || it.margin < 0.05;
  }

  // 5. Number generic speakers in order of first appearance.
  const order = [];
  for (const seg of segments) if (!order.includes(seg.speaker)) order.push(seg.speaker);
  const renames = new Map(); let n = 0;
  for (const name of order) if (generic(name)) renames.set(name, `Speaker ${++n}`);
  for (const seg of segments) if (renames.has(seg.speaker)) seg.speaker = renames.get(seg.speaker);
  for (const c of clusters) if (renames.has(c.name)) c.name = renames.get(c.name);
  const names = order.map((x) => renames.get(x) || x);
  names.clusters = clusters; // final voices (name + voiceprint), so a live tracker can continue from them
  return names;
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
