// Summaries and Q&A: a local model through Ollama (default) or Claude (optional), chosen automatically.
import os from 'os';

const GB = 1024 ** 3;

/* ---------------------------------------------------------------- Ollama */

async function ollama(host, pathname, { method = 'GET', body, timeoutMs = 5000, signal } = {}) {
  const r = await fetch(`${host}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: signal || AbortSignal.timeout(timeoutMs),
  });
  return r;
}

/** Installed models, or null when Ollama is not running. */
export async function ollamaModels(host) {
  try {
    const r = await ollama(host, '/api/tags', { timeoutMs: 1500 });
    if (!r.ok) return null;
    const { models = [] } = await r.json();
    return models.map((m) => ({
      name: m.name,
      sizeGB: +(m.size / GB).toFixed(1),
      family: m.details?.family || '',
      families: m.details?.families || [],
      paramsB: parseFloat(m.details?.parameter_size) || 0,
    }));
  } catch { return null; }
}

const NOT_FOR_CHAT = /embed|bert|code|rerank/i;
const VISION = /vl\b|llava|vision|clip|moondream/i;
const FAMILY_RANK = [/^qwen3/, /^qwen2\.5/, /^llama3/, /^gemma/, /^mistral|^mixtral/, /^phi/];

/** Largest installed text model that comfortably fits in RAM (vision models only as a last resort). */
export function pickInstalled(models, ramGB = os.totalmem() / GB) {
  const fits = models.filter((m) => !NOT_FOR_CHAT.test(`${m.name} ${m.family}`) && m.sizeGB <= ramGB * 0.55);
  const text = fits.filter((m) => !VISION.test(`${m.name} ${m.families.join(' ')}`));
  const pool = text.length ? text : fits;
  const rank = (m) => { const i = FAMILY_RANK.findIndex((re) => re.test(m.name)); return i < 0 ? 99 : i; };
  return pool.sort((a, b) => b.paramsB - a.paramsB || rank(a) - rank(b))[0] || null;
}

/** What to download when nothing suitable is installed, based on this machine's memory. */
export function recommendLLM(ramGB = os.totalmem() / GB) {
  if (ramGB >= 48) return { name: 'qwen3:32b', sizeGB: 20 };
  if (ramGB >= 16) return { name: 'qwen3:14b', sizeGB: 9.3 };
  if (ramGB >= 8) return { name: 'qwen3:8b', sizeGB: 5.2 };
  return { name: 'llama3.2:3b', sizeGB: 2 };
}

/** Stream a model download. onProgress({status, completed, total}). */
export async function pullModel(host, name, onProgress) {
  const r = await ollama(host, '/api/pull', { method: 'POST', body: { name, stream: true }, signal: AbortSignal.timeout(2 * 60 * 60 * 1000) });
  if (!r.ok || !r.body) throw new Error(`Ollama refused the download (${r.status})`);
  let buf = '';
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const j = JSON.parse(line);
      if (j.error) throw new Error(j.error);
      onProgress?.(j);
    }
  }
}

const THINKING = /qwen3|deepseek-r1|gpt-oss|magistral|cogito/i;
const stripThink = (t) => t.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

async function ollamaChat(host, model, system, user, { json, maxTokens, ctx }) {
  const base = {
    model, stream: false,
    options: { num_ctx: ctx, num_predict: maxTokens, temperature: 0.2 },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    ...(json ? { format: 'json' } : {}),
  };
  const call = (extra) => ollama(host, '/api/chat', { method: 'POST', body: { ...base, ...extra }, timeoutMs: 15 * 60 * 1000 });
  let r = await call(THINKING.test(model) ? { think: false } : {});
  if (r.status === 400) { // older Ollama / model without "think" support
    const t = await r.text();
    if (/think/i.test(t)) r = await call({});
    else throw new Error(`Ollama: ${t.slice(0, 200)}`);
  }
  if (!r.ok) throw new Error(`Ollama error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return stripThink(j.message?.content || '');
}

/* ---------------------------------------------------------------- Claude */

async function claudeChat(key, model, system, user, { maxTokens }) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message || `Anthropic API error ${r.status}`);
  return body.content?.map((c) => c.text || '').join('') || '';
}

/* ---------------------------------------------------------------- engine */

/**
 * Decide which engine to use. provider: 'auto' (local first, then Claude), 'local', 'anthropic'.
 * Returns { provider, model, ctxChars, complete(system, user, {json,maxTokens}) } or null.
 */
export async function resolveEngine({ provider = 'auto', model = 'auto', ollamaHost, anthropicKey, anthropicModel, builtin = null, ramGB = os.totalmem() / GB }) {
  if (provider !== 'anthropic' && provider !== 'builtin') {
    const models = await ollamaModels(ollamaHost);
    if (models) {
      const chosen = model && model !== 'auto' ? models.find((m) => m.name === model) : pickInstalled(models, ramGB);
      if (chosen) {
        // Context window we ask Ollama for, bounded by memory. ~3 characters per token for transcripts.
        const ctx = ramGB >= 32 ? 32768 : ramGB >= 16 ? 16384 : 8192;
        return {
          provider: 'local', model: chosen.name, ctxChars: ctx * 3,
          complete: (system, user, { json = false, maxTokens = 1500 } = {}) => {
            const need = Math.ceil((system.length + user.length) / 3) + maxTokens + 200;
            const c = [4096, 8192, 16384, 32768].find((n) => n >= need && n <= ctx) || ctx;
            return ollamaChat(ollamaHost, chosen.name, system, user, { json, maxTokens, ctx: c });
          },
        };
      }
    }
  }
  // The bundled model: runs inside the app, nothing to install. Used when Ollama is absent or unsuitable.
  if (provider !== 'anthropic' && builtin) {
    const m = builtin.installed();
    if (m) {
      return {
        provider: 'local', model: m.label.replace(/ \(.*\)$/, ''), builtin: true,
        get ctxChars() { return (builtin.contextSize || m.ctx) * 3; }, // tokens → characters, once the real context size is known
        prepare: () => builtin.ensure(m),
        complete: (system, user, { json = false, maxTokens = 1500 } = {}) => builtin.complete(system, user, { json, maxTokens }),
      };
    }
  }
  if (provider !== 'local' && provider !== 'builtin' && anthropicKey) {
    return {
      provider: 'anthropic', model: anthropicModel, ctxChars: 400000,
      complete: (system, user, { maxTokens = 1500 } = {}) => claudeChat(anthropicKey, anthropicModel, system, user, { maxTokens }),
    };
  }
  return null;
}

/* --------------------------------------------------- meeting-level prompts */

const SUMMARY_SYSTEM = `You summarize meeting transcripts. Reply with ONLY a JSON object, no prose, no code fences:
{"title": string (max 8 words), "summary": string (3-6 sentences), "topics": string[], "decisions": string[], "actionItems": [{"task": string, "owner": string|null, "due": string|null}], "speakers": [{"name": string, "role": string (max 10 words: what this person did in the meeting), "points": string[] (their key points or commitments)}]}
Use only what is in the transcript. Do not invent owners or dates. Keep speaker labels exactly as given (You, Speaker 1, a person's name).
A trailing "(?)" after a speaker label means the app is NOT sure who said that line (overlapping voices, short or noisy audio). Never assign an action item owner or a decision to a person based only on "(?)" lines: use owner null instead, and do not quote "(?)" lines as that person's views.`;

const NOTES_SYSTEM = `You take notes on one part of a long meeting transcript. List the key points, decisions, and action items (with owner and due date only if stated) as terse bullet points. Use only what is in the text.`;

const ASK_SYSTEM = 'Answer questions about a meeting using only its transcript. Cite timestamps like [12:30] where useful. If the transcript does not contain the answer, say so.';

function parseJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('The model did not return JSON');
  return JSON.parse(text.slice(s, e + 1));
}

const strList = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x?.text || x?.task || '')).filter(Boolean) : []);
const UNSURE = /\s*\(\?\)\s*$/;
function normalizeSummary(o) {
  // Small models sometimes copy the "(?)" marker into names or give an uncertain line an owner. Enforce the rule here.
  const speakers = new Map();
  for (const p of Array.isArray(o.speakers) ? o.speakers : []) {
    const name = String(p?.name || '').replace(UNSURE, '').slice(0, 60);
    if (!name) continue;
    const cur = speakers.get(name) || { name, role: '', points: [] };
    cur.role = cur.role || String(p?.role || '').slice(0, 120);
    cur.points.push(...strList(p?.points).filter((x) => !cur.points.includes(x)));
    speakers.set(name, cur);
  }
  return {
    title: typeof o.title === 'string' ? o.title.slice(0, 120) : '',
    summary: typeof o.summary === 'string' ? o.summary : strList(o.summary).join(' '),
    topics: strList(o.topics),
    decisions: strList(o.decisions),
    speakers: [...speakers.values()],
    actionItems: (Array.isArray(o.actionItems) ? o.actionItems : []).map((a) => {
      if (typeof a === 'string') return { task: a, owner: null, due: null };
      const owner = a?.owner ? String(a.owner) : null;
      return { task: String(a?.task || ''), owner: owner && !UNSURE.test(owner) ? owner : null, due: a?.due ? String(a.due) : null };
    }).filter((a) => a.task),
  };
}

function chunkLines(text, maxChars) {
  const chunks = []; let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > maxChars) { chunks.push(cur); cur = ''; }
    cur += `${cur ? '\n' : ''}${line}`;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export async function summarize(engine, title, transcript) {
  await engine.prepare?.(); // the bundled model reports its real context size once loaded
  const budget = engine.ctxChars - 7000;
  let body = transcript;
  let note = '';
  if (transcript.length > budget) { // long meeting: take notes per part, then summarize the notes
    const parts = chunkLines(transcript, Math.floor(budget * 0.7));
    const notes = [];
    for (const p of parts) notes.push(await engine.complete(NOTES_SYSTEM, p, { maxTokens: 800 }));
    body = notes.map((n, i) => `Part ${i + 1}:\n${n}`).join('\n\n');
    note = '\n(This is a condensed set of notes from a long transcript.)';
  }
  const user = `Meeting: ${title}${note}\n\nTranscript:\n${body}`;
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return normalizeSummary(parseJson(await engine.complete(SUMMARY_SYSTEM, user, { json: true, maxTokens: 2500 }))); }
    catch (e) { last = e; }
  }
  throw last;
}

export async function ask(engine, transcript, question) {
  await engine.prepare?.();
  let text = transcript;
  const budget = engine.ctxChars - 4000;
  if (text.length > budget) { // keep the parts of the transcript that mention the question's words
    const words = [...new Set(question.toLowerCase().match(/[a-z0-9]{4,}/g) || [])];
    const chunks = chunkLines(text, 3000).map((c, i) => ({ c, i, score: words.filter((w) => c.toLowerCase().includes(w)).length }));
    const keep = []; let used = 0;
    for (const ch of [...chunks].sort((a, b) => b.score - a.score || a.i - b.i)) {
      if (used + ch.c.length > budget) continue;
      keep.push(ch); used += ch.c.length;
    }
    text = keep.sort((a, b) => a.i - b.i).map((k) => k.c).join('\n…\n');
  }
  return engine.complete(ASK_SYSTEM, `Transcript:\n${text}\n\nQuestion: ${question}`, { maxTokens: 1200 });
}
