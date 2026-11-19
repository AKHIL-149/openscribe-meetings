/* Meeting Recorder frontend (no build step). */

const $ = (s) => document.querySelector(s);
const main = $('#main');

const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    e.append(k.nodeType ? k : document.createTextNode(k));
  }
  return e;
};

async function api(url, { method = 'GET', body } = {}) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

const fmt = (s) => {
  s = Math.max(0, Math.floor(s));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
};
const fmtDate = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

let config = { transcription: 'local', ai: false, language: 'en' };
let currentId = null;
let recording = null; // active recording session, if any

/* ---------------------------------------------------------------- library */

async function refreshList() {
  const q = $('#search').value.trim();
  const list = await api(`/api/meetings${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const ul = $('#list');
  ul.replaceChildren(...list.map((m) => h('li', {
    class: m.id === currentId ? 'active' : '',
    onclick: () => openMeeting(m.id),
  },
  h('div', { class: 't' }, m.title),
  h('div', { class: 'm' }, `${fmtDate(m.createdAt)} · ${m.status === 'recording' ? (m.localBot ? `bot: ${(BOT_LABELS[m.botStatus] || m.botStatus).replace(/…$/, '')}` : 'recording…') : m.status === 'bot' ? `bot: ${(BOT_LABELS[m.botStatus] || m.botStatus).replace(/…$/, '')}` : fmt(m.durationSec)}`))));
  if (!list.length) ul.append(h('li', { class: 'm' }, q ? 'No matches' : 'No meetings yet'));
}

$('#search').addEventListener('input', debounce(refreshList, 250));
$('#new').addEventListener('click', showRecorder);
$('#settings').addEventListener('click', openSettings);

async function openSettings() {
  const cur = await api('/api/settings');
  const f = (label, name, hint, type = 'password') => {
    const input = h('input', { type, value: cur[name] || '', placeholder: 'not set', autocomplete: 'off', style: 'width:100%' });
    return { input, row: h('label', { style: 'display:block;margin-top:12px' }, h('b', {}, label), h('div', { class: 'muted' }, hint), input) };
  };
  const opt = (v, l, sel) => h('option', { value: v, selected: sel ? 'selected' : null }, l);
  const dg = f('Deepgram API key (optional)', 'deepgramKey', 'Cloud transcription with automatic speaker labels. Leave empty to stay fully on-device.');
  const an = f('Anthropic API key (optional)', 'anthropicKey', 'Use Claude for summaries instead of / in addition to a local model.');
  const rc = f('Recall.ai API key (optional)', 'recallKey', 'Optional. The desktop app already has a built-in bot that needs no key; this is only for the browser version.');
  const region = h('select', {}, ...['us-west-2', 'us-east-1', 'eu-central-1', 'ap-northeast-1'].map((r) => opt(r, r, r === cur.recallRegion)));
  const lang = h('input', { value: cur.language, style: 'width:90px' });
  const sttProvider = h('select', {}, opt('local', 'On this device (Whisper)', cur.sttProvider === 'local'), opt('deepgram', 'Deepgram (cloud)', cur.sttProvider === 'deepgram'));
  const sttModel = h('select', {});
  const llmProvider = h('select', {}, opt('auto', 'Automatic (on-device first)', cur.llmProvider === 'auto'), opt('local', 'On this device only', cur.llmProvider === 'local'), opt('builtin', 'Bundled model only (no Ollama)', cur.llmProvider === 'builtin'), opt('anthropic', 'Claude (cloud)', cur.llmProvider === 'anthropic'));
  const llmModel = h('select', {});
  const speakerId = h('select', {}, opt('on', 'On: tell speakers apart and label them', cur.speakerId !== 'off'), opt('off', 'Off: just “You” and “Others”', cur.speakerId === 'off'));
  const voicesBox = h('div', { class: 'muted' }, 'Loading…');
  const localBox = h('div', { class: 'muted', style: 'margin-top:8px' }, 'Checking this computer…');
  const msg = h('span', { class: 'muted' });
  let timer = null, built = false;

  const bar = (done, total) => (total ? ` ${Math.round((done / total) * 100)}%` : '');
  async function refreshLocal() {
    let st; try { st = await api('/api/local/status'); } catch { return; }
    const hw = st.hardware, e = st.stt.engine, l = st.llm, chosen = st.stt.chosen;
    if (!built) { // fill the pickers once so the user's selection is not reset by polling
      built = true;
      sttModel.replaceChildren(opt('auto', `Automatic (best for this computer: ${chosen.label})`, st.stt.setting === 'auto'),
        ...['turbo', 'small', 'base', 'tiny'].map((t) => opt(t, `Whisper ${t}`, st.stt.setting === t)));
      llmModel.replaceChildren(opt('auto', `Automatic${l.chosen ? ` (largest that fits: ${l.chosen.name})` : ''}`, cur.llmModel === 'auto'),
        ...l.installed.filter((m) => !/embed|bert|code|llava/i.test(m.name)).map((m) => opt(m.name, `${m.name} (${m.sizeGB} GB)`, cur.llmModel === m.name)));
    }
    const sttLine = e.state === 'downloading' ? `Downloading ${chosen.label}…${bar(e.progress, 1)}`
      : e.state === 'loading' ? 'Loading the speech model…'
      : e.state === 'ready' ? `✓ ${chosen.label} is ready${e.downgraded ? ' (stepped down automatically to keep up)' : ''}`
      : e.state === 'error' ? `⚠ ${e.error}`
      : `${chosen.label} (~${chosen.approxMB} MB) downloads on first use.`;
    const sp = st.speaker || {};
    const spLine = !sp.enabled ? 'Off.' : sp.engine?.state === 'downloading' ? `Downloading the speaker model… ${bar(sp.engine.progress, 1)}`
      : sp.engine?.state === 'ready' ? '✓ ready' : sp.engine?.state === 'error' ? `⚠ ${sp.engine.error}` : 'Models (~44 MB) download on first use.';
    const pull = l.pull;
    const bi = l.builtin || {};
    const llmLine = l.reachable && l.chosen ? `✓ Summaries use ${l.chosen.name} (${l.chosen.sizeGB} GB) through Ollama, on this device.`
      : bi.installed ? `✓ Summaries use the bundled model on this device${bi.state === 'loading' ? ' (loading…)' : ''}. Nothing else to install.`
      : bi.state === 'downloading' ? `Downloading the summary model… ${Math.round((bi.progress || 0) * 100)}%`
      : bi.state === 'error' ? `⚠ ${bi.error}`
      : bi.recommended ? `No summary model yet. One free download (${bi.recommended.label}, ~${bi.recommended.sizeGB} GB) runs it inside this app. No Ollama or account needed.`
      : `This computer has too little memory for the bundled model. You can install Ollama (ollama.com) or add a Claude key.`;
    localBox.replaceChildren(...[
      h('div', {}, `💻 ${hw.cpu} · ${hw.cores} cores · ${hw.ramGB} GB RAM`),
      h('div', { style: 'margin-top:6px' }, h('b', {}, 'Speech: '), sttLine,
        e.state === 'idle' || e.state === 'error' ? h('button', { style: 'margin-left:8px', onclick: () => api('/api/local/stt/load', { method: 'POST' }).then(refreshLocal) }, 'Download now') : null),
      h('div', { style: 'margin-top:6px' }, h('b', {}, 'Speakers: '), spLine),
      h('div', { style: 'margin-top:6px' }, h('b', {}, 'Summaries: '), llmLine),
      pull.active ? h('div', {}, `Downloading ${pull.model}: ${pull.status}${bar(pull.completed, pull.total)}`) : null,
      pull.error ? h('div', { class: 'notice' }, pull.error) : null,
      !(l.reachable && l.chosen) && !bi.installed && bi.recommended && bi.state !== 'downloading' ? h('button', { style: 'margin-top:6px', onclick: async () => {
        try { await api('/api/local/llm/builtin/download', { method: 'POST' }); } catch (err) { msg.textContent = err.message; }
        refreshLocal();
      } }, `Download the summary model (~${bi.recommended.sizeGB} GB)`) : null,
      l.reachable && !l.chosen && !bi.installed && !pull.active ? h('button', { style: 'margin-top:6px', onclick: async () => {
        try { await api('/api/local/llm/pull', { method: 'POST', body: { model: l.recommended.name } }); } catch (err) { msg.textContent = err.message; }
        refreshLocal();
      } }, `Download ${l.recommended.name} (~${l.recommended.sizeGB} GB)`) : null].filter(Boolean));
  }

  const dlg = h('dialog', { class: 'card' },
    h('h1', {}, 'Settings'),
    h('div', { class: 'notice', style: 'background:var(--chip);color:var(--text)' }, config.storage?.encrypted
      ? `🔒 Recordings, transcripts and keys are encrypted on disk (AES-256). Encryption key: ${config.storage.keySource}.${config.storage.keySource === 'key-file' ? ' This key sits in the data folder, so also use full-disk encryption (FileVault/BitLocker).' : ''}`
      : 'Storage is not encrypted.'),
    h('h2', {}, 'On-device AI'),
    localBox,
    h('label', { style: 'display:block;margin-top:12px' }, h('b', {}, 'Speaker recognition'), h('div', {}, speakerId)),
    h('div', { class: 'notice', style: 'background:var(--chip);color:var(--text)' }, '🎙 Remembered voices are biometric data. They are stored only on this computer (encrypted), only when you press “Remember voice”, and only for people who agreed. Delete them here at any time.'),
    voicesBox,
    h('label', { style: 'display:block;margin-top:12px' }, h('b', {}, 'Transcription'), h('div', {}, sttProvider)),
    h('label', { style: 'display:block;margin-top:8px' }, h('b', {}, 'Speech model'), h('div', {}, sttModel)),
    h('label', { style: 'display:block;margin-top:8px' }, h('b', {}, 'Summaries & Ask'), h('div', {}, llmProvider)),
    h('label', { style: 'display:block;margin-top:8px' }, h('b', {}, 'Local summary model'), h('div', {}, llmModel)),
    h('h2', {}, 'Optional cloud services'),
    dg.row, an.row, rc.row,
    h('div', { class: 'row', style: 'margin-top:12px' }, h('label', {}, 'Recall region ', region), h('label', {}, 'Language ', lang)),
    h('div', { class: 'row', style: 'margin-top:18px' }, msg, h('span', { class: 'grow' }),
      h('button', { onclick: () => dlg.close() }, 'Cancel'),
      h('button', { class: 'primary', onclick: async () => {
        try {
          await api('/api/settings', { method: 'PUT', body: {
            deepgramKey: dg.input.value, anthropicKey: an.input.value, recallKey: rc.input.value, recallRegion: region.value, language: lang.value.trim(),
            sttProvider: sttProvider.value, sttModel: sttModel.value, speakerId: speakerId.value, llmProvider: llmProvider.value, llmModel: llmModel.value,
          } });
          await loadConfig(); dlg.close(); if (!recording && !currentId) showRecorder();
        } catch (e) { msg.textContent = e.message; }
      } }, 'Save')));
  dlg.addEventListener('close', () => { clearInterval(timer); dlg.remove(); });
  document.body.append(dlg);
  dlg.showModal();
  async function refreshVoices() {
    let list = []; try { list = await api('/api/voices'); } catch { /* ignore */ }
    voicesBox.replaceChildren(
      h('b', {}, `Remembered voices (${list.length})`),
      ...list.map((v) => h('div', { class: 'row', style: 'margin-top:4px' }, h('span', { class: 'grow' }, `${v.name} `, h('span', { class: 'muted' }, `· ${v.samples} samples`)),
        h('button', { onclick: async () => { await api(`/api/voices/${v.id}`, { method: 'DELETE' }); refreshVoices(); } }, 'Delete'))),
      list.length ? h('button', { class: 'danger', style: 'margin-top:6px', onclick: async () => { if (confirm('Delete all remembered voices?')) { await api('/api/voices', { method: 'DELETE' }); refreshVoices(); } } }, 'Delete all') : h('div', {}, 'None yet. Rename a speaker in a meeting, then press “Remember voice”.'));
  }
  refreshVoices();
  await refreshLocal();
  timer = setInterval(refreshLocal, 1500);
}

async function loadConfig() {
  config = await api('/api/config');
  $('#status').textContent = `${config.transcription === 'deepgram' ? 'Transcription: Deepgram (cloud)' : 'Transcription: on this device'} · AI: ${config.ai ? `${config.aiProvider === 'local' ? 'on this device' : 'Claude'} (${config.aiModel})` : 'not set up'} · Bot: ${config.bots ? 'on' : 'off'}`;
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* --------------------------------------------------------------- recorder */

function showRecorder() {
  if (recording) return; // already recording; recorder view stays up
  currentId = null;
  refreshList();

  const title = h('input', { class: 'grow', placeholder: 'Meeting title (optional)' });
  const platform = h('select', {},
    ...[['meet', 'Google Meet'], ['zoom', 'Zoom'], ['teams', 'Microsoft Teams'], ['webex', 'Webex'], ['other', 'Other / in person']]
      .map(([v, l]) => h('option', { value: v }, l)));
  const useMic = h('input', { type: 'checkbox', checked: 'checked', id: 'mic' });
  const share = h('input', { type: 'checkbox', checked: 'checked', id: 'share' });
  const device = h('select', { title: 'Microphone or loopback device (e.g. BlackHole on macOS)' }, h('option', { value: '' }, 'Default microphone'));
  navigator.mediaDevices.enumerateDevices().then((ds) => {
    ds.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .forEach((d, i) => device.append(h('option', { value: d.deviceId }, d.label || `Input ${i + 1}`)));
  }).catch(() => {});
  const room = h('input', { type: 'checkbox', id: 'room' });
  platform.addEventListener('change', () => { room.checked = platform.value === 'other'; }); // in-person: everyone shares the mic
  const startBtn = h('button', { class: 'primary', onclick: () => start() }, '● Start recording');
  const errBox = h('div');

  const modeNote = config.transcription === 'deepgram'
    ? 'Transcription: Deepgram (cloud). Audio is sent to Deepgram. Switch to on-device in ⚙ Settings to keep everything on this computer.'
    : '🔒 Transcription runs on this computer; no audio leaves it. Your microphone is labelled “You” and the meeting audio “Others”. The first recording downloads the speech model once.';

  main.replaceChildren(h('div', { class: 'wrap' },
    h('h1', {}, 'New recording'),
    h('p', { class: 'muted' }, 'Works with Google Meet, Zoom, Teams and anything else that plays audio in your browser or on your computer.'),
    h('div', { class: 'card' },
      h('div', { class: 'row' }, title, platform),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('label', { class: 'row' }, useMic, 'Include audio input'), device),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('label', { class: 'row', title: 'Tell the voices on your microphone apart (in-person meetings)' }, room, 'Several people share my microphone'),
        h('span', { class: 'muted' }, '(in-person)')),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('label', { class: 'row' }, share, 'Capture meeting audio from a tab/screen'),
        h('span', { class: 'grow' }), startBtn),
      h('div', { class: 'notice' }, h('b', {}, 'How to capture the call: '),
        'click Start, then in the picker choose the Chrome tab with your meeting and tick “Share tab audio”. ',
        'For the Zoom desktop app, pick “Entire screen” and tick “Share system audio” (Windows/ChromeOS; on macOS use a loopback device like BlackHole, or run Zoom in the browser).'),
      h('div', { class: 'notice' }, modeNote),
      h('div', { class: 'notice' }, 'Tell participants they are being recorded. Many places legally require everyone\'s consent.'),
      errBox),
    h('div', { id: 'live' }),
    botCard()));

  async function start() {
    startBtn.disabled = true;
    errBox.replaceChildren();
    try {
      await startRecording({ title: title.value.trim(), platform: platform.value, mic: useMic.checked, deviceId: device.value, share: share.checked, room: room.checked });
    } catch (e) {
      startBtn.disabled = false;
      errBox.replaceChildren(h('div', { class: 'notice' }, e.name === 'NotAllowedError' ? 'Permission was denied or the picker was cancelled.' : e.message));
    }
  }
}

function botCard() {
  if (!config.bots) {
    return h('div', { class: 'card', style: 'margin-top:16px' },
      h('b', {}, 'Send a bot to the meeting'),
      h('p', { class: 'muted' }, 'The built-in notetaker bot is part of the desktop app. In the browser version it needs a Recall.ai key in ⚙ Settings.'));
  }
  const local = config.botProvider === 'local';
  const url = h('input', { class: 'grow', placeholder: 'Paste a Meet, Zoom, Teams or Webex link', type: 'url' });
  const name = h('input', { value: 'Meeting Notetaker', style: 'width:200px', maxlength: '100', title: 'Name the bot shows in the meeting' });
  const err = h('div');
  const btn = h('button', { class: 'primary', onclick: async () => {
    if (!url.value.trim()) return;
    btn.disabled = true; err.replaceChildren();
    try {
      const m = await api('/api/bots', { method: 'POST', body: { meetingUrl: url.value.trim(), botName: name.value.trim() } });
      await openMeeting(m.id);
    } catch (e) { btn.disabled = false; err.replaceChildren(h('div', { class: 'notice' }, e.message)); }
  } }, 'Send bot');
  return h('div', { class: 'card', style: 'margin-top:16px' },
    h('b', {}, 'Send a bot to the meeting'),
    h('p', { class: 'muted' }, local
      ? 'A guest joins your link from this computer, listens, and transcribes live on this device. Nothing leaves your computer and no account or key is needed. It shows up as a visible participant, and the host may need to admit it. It cannot join meetings that require signing in.'
      : 'The bot joins as a visible participant (you may need to admit it from the waiting room). The transcript and recording appear here after the meeting ends.'),
    h('div', { class: 'row' }, url, name, btn), err);
}

const BOT_LABELS = {
  joining_call: 'Joining the meeting…', in_waiting_room: 'In the waiting room — admit the bot to let it in',
  in_call_not_recording: 'In the call, not recording yet', recording_permission_allowed: 'Recording permission granted',
  recording_permission_denied: 'Recording permission was denied by the host', in_call_recording: 'In the call and recording',
  needs_you: 'Needs you — click “Show bot window”', call_ended: 'Call ended, processing…', done: 'Done', fatal: 'Failed',
};

async function startRecording({ title, platform, mic, deviceId, share, room }) {
  const display = share
    ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: 'include' })
    : new MediaStream();
  let micStream = null;
  if (mic) {
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: !deviceId, noiseSuppression: !deviceId } }); }
    catch { /* continue without mic */ }
  }
  const hasTabAudio = display.getAudioTracks().length > 0;
  if (!hasTabAudio && !micStream) {
    display.getTracks().forEach((t) => t.stop());
    throw new Error('No audio source available. Tick “Share tab audio” (or system audio) in the picker, or allow the microphone.');
  }
  display.getVideoTracks().forEach((t) => t.stop()); // we only want audio; stopping video ends the picker's banner for video

  const meeting = await api('/api/meetings', { method: 'POST', body: { title, platform } });
  currentId = meeting.id;

  // Mix tab + mic into a single stream, at 16 kHz for the transcriber.
  const ctx = new AudioContext({ sampleRate: 16000 });
  const mix = ctx.createGain();
  const dest = ctx.createMediaStreamDestination();
  const tabSrc = hasTabAudio ? ctx.createMediaStreamSource(new MediaStream(display.getAudioTracks())) : null;
  const micSrc = micStream ? ctx.createMediaStreamSource(micStream) : null;
  tabSrc?.connect(mix);
  micSrc?.connect(mix);
  mix.connect(dest);

  const rec = {
    meeting, ctx, display, micStream, hasTabAudio,
    startedAt: performance.now(), segments: [], interim: '', ws: null, recorder: null, timer: null, engine: null, now: null, room: Boolean(room),
    wsUp: false, retry: 0, pcm: [], pcmBytes: 0, pcmDropped: false, stopping: false, warn: null,
    up: { chunks: [], total: 0, i: 0, acked: 0, busy: false, fails: 0, timer: null, pending: Promise.resolve(), broken: false },
  };
  recording = rec;

  // Local recording (opus/webm). Each 3-second chunk is uploaded and written (encrypted) to disk as it is made,
  // so if the app or computer dies mid-meeting at most the last few seconds are lost.
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  rec.recorder = new MediaRecorder(dest.stream, { mimeType: mime });
  rec.recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    rec.up.pending = rec.up.pending.then(async () => { // keep chunks in order
      const buf = await e.data.arrayBuffer();
      rec.up.chunks.push({ offset: rec.up.total, buf }); rec.up.total += buf.byteLength;
      pumpAudio(rec);
    });
  };
  rec.recorder.start(3000);

  // Live transcript socket (reconnects by itself; audio is buffered while it is down).
  connectSocket(rec);

  // Stream 16 kHz PCM to the server. On-device mode sends the mic (channel 0 = "You") and the meeting
  // audio (channel 1 = "Others") separately so speakers can be told apart without any cloud diarization.
  await ctx.audioWorklet.addModule('/pcm-worklet.js');
  const silent = ctx.createGain();
  silent.gain.value = 0;
  silent.connect(ctx.destination);
  const tap = (source, channel) => {
    const node = new AudioWorkletNode(ctx, 'pcm-processor');
    source.connect(node); node.connect(silent);
    node.port.onmessage = (e) => {
      if (rec.stopping) return;
      if (channel === null) return sendPcm(rec, e.data);
      const out = new Uint8Array(e.data.byteLength + 1);
      out[0] = channel; out.set(new Uint8Array(e.data), 1);
      sendPcm(rec, out);
    };
  };
  if (config.transcription === 'deepgram') tap(mix, null);
  else { if (micSrc) tap(micSrc, 0); if (tabSrc) tap(tabSrc, 1); }

  // Stop automatically if the user ends sharing from the browser's banner.
  display.getAudioTracks().forEach((t) => t.addEventListener('ended', () => stopRecording()));

  rec.timer = setInterval(renderLive, 500);
  renderLive();
  refreshList();
}

/* ---- live connection: reconnecting socket + audio buffer ---- */

function connectSocket(rec) {
  if (rec.stopping) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?meetingId=${rec.meeting.id}&lang=${config.language}${rec.room ? '&room=1' : ''}`);
  ws.binaryType = 'arraybuffer';
  rec.ws = ws;
  ws.onopen = () => {
    rec.wsUp = true; rec.retry = 0; rec.warn = null;
    for (const frame of rec.pcm.splice(0)) ws.send(frame); // catch up on audio captured while disconnected, in order
    rec.pcmBytes = 0;
    renderLive();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'segment') { rec.segments.push(msg.segment); rec.now = { speaker: msg.segment.speaker, uncertain: msg.segment.uncertain, at: Date.now() }; }
    else if (msg.type === 'sync') rec.segments = msg.segments;
    else if (msg.type === 'interim') rec.interim = msg.text;
    else if (msg.type === 'error') rec.error = msg.message;
    else if (msg.type === 'engine') rec.engine = msg;
    renderLive();
  };
  ws.onerror = () => {};
  ws.onclose = (ev) => {
    if (rec.ws !== ws) return;
    rec.wsUp = false;
    if (recording !== rec || rec.stopping) return;
    if (ev.code === 4004 || ev.code === 4005) { rec.warn = 'The live transcript has ended. Audio is still being recorded.'; renderLive(); return; }
    rec.warn = 'Lost the connection to the transcriber. Reconnecting… audio is still being recorded and will be transcribed when it is back.';
    setTimeout(() => connectSocket(rec), Math.min(10000, 500 * 2 ** rec.retry++));
    renderLive();
  };
}

function sendPcm(rec, bytes) {
  if (rec.wsUp && rec.ws.readyState === WebSocket.OPEN) { rec.ws.send(bytes); return; }
  rec.pcm.push(bytes); rec.pcmBytes += bytes.byteLength; // keep up to ~64 MB (about 17 minutes of both channels)
  while (rec.pcmBytes > 64 * 1048576) { rec.pcmBytes -= rec.pcm.shift().byteLength; rec.pcmDropped = true; }
}

/* ---- audio upload: ordered chunks, retried until the server has them ---- */

async function pumpAudio(rec) {
  const up = rec.up;
  if (up.busy || up.broken) return;
  up.busy = true;
  try {
    while (up.i < up.chunks.length) {
      const c = up.chunks[up.i];
      const r = await fetch(`/api/meetings/${rec.meeting.id}/audio-chunk?offset=${c.offset}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: c.buf });
      if (r.status === 409) { // the server is behind: resume from where it actually is
        const { size } = await r.json().catch(() => ({}));
        const at = up.chunks.findIndex((x) => x.offset === size);
        if (at < 0) { up.broken = true; rec.error = 'Part of the audio could not be saved. The transcript is unaffected.'; return; }
        up.i = at; continue;
      }
      if (!r.ok) throw new Error(`upload ${r.status}`);
      up.acked = (await r.json()).size; up.i++; up.fails = 0;
    }
  } catch {
    up.fails++;
    clearTimeout(up.timer);
    up.timer = setTimeout(() => pumpAudio(rec), Math.min(15000, 1000 * 2 ** Math.min(up.fails, 4)));
  } finally { up.busy = false; }
}

async function drainAudio(rec, maxMs) {
  const up = rec.up, t0 = Date.now();
  await up.pending;
  while (!up.broken && up.i < up.chunks.length && Date.now() - t0 < maxMs) { pumpAudio(rec); await new Promise((r) => setTimeout(r, 400)); }
  return up.i >= up.chunks.length;
}

// Small hook so automated tests can simulate a dropped connection. It can only close the live socket.
window.__mrTest = {
  dropSocket: () => recording?.ws?.close(),
  state: () => recording && { wsUp: recording.wsUp, bufferedFrames: recording.pcm.length, audioAcked: recording.up.acked, audioTotal: recording.up.total, segments: recording.segments.length },
};

function renderLive() {
  const rec = recording;
  if (!rec) return;
  let view = $('#live');
  if (!view) { // recorder view was replaced; rebuild a minimal one
    main.replaceChildren(h('div', { class: 'wrap' }, h('div', { id: 'live' })));
    view = $('#live');
  }
  const elapsed = (performance.now() - rec.startedAt) / 1000;

  // Build the card once so the Stop button is never replaced mid-click; afterwards only update parts.
  if (!$('#rec-card')) {
    view.replaceChildren(h('div', { class: 'card', id: 'rec-card' },
      h('div', { class: 'row' },
        h('span', { class: 'live' }, 'REC'),
        h('div', { class: 'timer grow', id: 'rec-timer' }),
        h('button', { class: 'danger', onclick: () => stopRecording() }, '■ Stop & save')),
      h('div', { class: 'muted' }, rec.meeting.title),
      !rec.hasTabAudio ? h('div', { class: 'notice' }, 'No tab/system audio was shared: only the selected audio input is being recorded.') : null,
      h('div', { id: 'rec-error' }),
      h('div', { id: 'rec-now', class: 'nowbar' }),
      h('div', { id: 'rec-engine', class: 'muted' }),
      h('div', { class: 'transcript', id: 'tbox' })));
  }
  $('#rec-timer').textContent = fmt(elapsed);
  const en = rec.engine;
  $('#rec-engine').textContent = !en || config.transcription === 'deepgram' ? ''
    : en.state === 'downloading' ? `Downloading the speech model (one time): ${Math.round((en.progress || 0) * 100)}%. Audio is being recorded meanwhile.`
    : en.state === 'loading' ? 'Loading the speech model…'
    : en.speaker && en.speaker.state === 'downloading' ? `Downloading the speaker-recognition model (one time): ${Math.round((en.speaker.progress || 0) * 100)}%.`
    : en.pending ? `Transcribing… (${en.pending} waiting)` : '';
  // Who is talking right now, and who has been heard so far.
  const now = $('#rec-now');
  const heard = new Map();
  for (const sg of rec.segments) heard.set(sg.speaker, (heard.get(sg.speaker) || 0) + 1);
  const recent = rec.now && Date.now() - rec.now.at < 7000;
  now.replaceChildren(
    h('span', { class: recent ? 'speaking' : 'muted' }, recent ? ['🎙 ', spkDot(rec.now.speaker), rec.now.speaker, rec.now.uncertain ? ' (?)' : ''] : (heard.size ? '🎙 quiet' : '')),
    ...[...heard].map(([name, n]) => h('span', { class: 'chip', title: `${n} lines so far` }, spkDot(name), name)));
  const err = $('#rec-error');
  const note = rec.error || rec.warn || (rec.pcmDropped ? 'The connection was down for a long time; the oldest buffered audio was dropped from the transcript (the recording itself is complete).' : '');
  if (err.dataset.note !== note) { err.dataset.note = note; err.replaceChildren(...(note ? [h('div', { class: 'notice' }, note)] : [])); }

  const n = rec.segments.length + (rec.interim ? 1 : 0);
  const box = $('#tbox');
  if (box.dataset.n === `${rec.segments.length}|${rec.interim}`) return; // nothing changed
  box.dataset.n = `${rec.segments.length}|${rec.interim}`;
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  box.replaceChildren(
    ...rec.segments.map((sg) => segRow(sg)),
    rec.interim ? h('div', { class: 'seg interim' }, h('span'), h('div', { class: 'tx' }, rec.interim)) : null,
    !n ? h('div', { class: 'muted' }, 'Listening… the transcript appears here as people speak.') : null);
  if (stick) box.scrollTop = box.scrollHeight;
}

// Each speaker keeps one colour for the whole view (colour is never the only cue: the name is always shown).
const SPK_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#06b6d4', '#84cc16', '#ef4444'];
const spkOrder = new Map();
const spkColor = (name) => { if (!spkOrder.has(name)) spkOrder.set(name, spkOrder.size); return SPK_COLORS[spkOrder.get(name) % SPK_COLORS.length]; };
const spkDot = (name) => h('span', { class: 'dot', style: `background:${spkColor(name)}` });

function segRow(seg, onPick) {
  const flags = [
    seg.overlap ? h('span', { class: 'badge', title: 'People were talking at the same time, so this line may mix voices' }, '⇄ overlap') : null,
    seg.uncertain ? h('span', { class: 'badge warn', title: 'Not sure who said this. Click the name to fix it.' }, '? unsure') : null,
    seg.manual ? h('span', { class: 'badge', title: 'You set this speaker' }, '✎') : null,
  ];
  return h('div', { class: `seg${seg.uncertain ? ' unsure' : ''}`, 'data-id': seg.id },
    h('button', { class: 'ts', title: 'Jump to this moment', 'data-t': seg.start }, fmt(seg.start)),
    h('div', {}, h('span', { class: 'sp', title: onPick ? 'Click to change who said this' : null, onclick: onPick ? () => onPick(seg) : null }, spkDot(seg.speaker), seg.speaker),
      ' ', ...flags, ' ', h('span', { class: 'tx' }, seg.text)));
}

// "Who said this?" dialog: pick an existing speaker, type a new name, or rename everyone with this label.
function pickSpeaker(seg, speakers, { onChoose, onRenameAll }) {
  const dlg = h('dialog', { class: 'card' });
  const choose = (name) => { dlg.close(); onChoose(name); };
  dlg.append(
    h('h1', {}, 'Who said this?'),
    h('p', { class: 'muted' }, `“${seg.text.length > 110 ? `${seg.text.slice(0, 110)}…` : seg.text}”`),
    h('div', { class: 'chips', style: 'gap:8px' }, ...speakers.map((sp) => h('button', { onclick: () => choose(sp.name), style: sp.name === seg.speaker ? 'outline:2px solid var(--accent)' : '' }, spkDot(sp.name), sp.name))),
    h('div', { class: 'row', style: 'margin-top:14px' },
      h('button', { onclick: () => { const n = prompt('Name of the speaker:'); if (n && n.trim()) choose(n.trim()); } }, '＋ Someone else…'),
      h('button', { onclick: () => { const n = prompt(`Rename everyone currently labelled “${seg.speaker}” to:`, seg.speaker); if (n && n.trim() && n.trim() !== seg.speaker) { dlg.close(); onRenameAll(seg.speaker, n.trim()); } } }, `Rename all “${seg.speaker}”…`),
      h('span', { class: 'grow' }), h('button', { onclick: () => dlg.close() }, 'Cancel')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}

async function stopRecording() {
  const rec = recording;
  if (!rec) return;
  recording = null;
  rec.stopping = true;
  clearInterval(rec.timer);
  const duration = (performance.now() - rec.startedAt) / 1000;

  main.replaceChildren(h('div', { class: 'wrap empty' }, 'Finishing up and saving the recording…'));

  const stopped = new Promise((res) => { rec.recorder.onstop = res; });
  if (rec.recorder.state !== 'inactive') rec.recorder.stop();
  await stopped;
  rec.display.getTracks().forEach((t) => t.stop());
  rec.micStream?.getTracks().forEach((t) => t.stop());
  rec.ctx.close();

  // 1. Make sure the transcriber has every bit of audio, then tell it to finish. If the live socket is down,
  //    give it a moment to come back so the tail of the meeting is not lost; otherwise stop over plain HTTP.
  for (let i = 0; i < 40 && !(rec.wsUp && rec.ws.readyState === WebSocket.OPEN) && rec.pcm.length; i++) {
    if (i === 0) connectSocketForStop(rec);
    await new Promise((r) => setTimeout(r, 500));
  }
  if (rec.wsUp && rec.ws.readyState === WebSocket.OPEN) {
    for (const frame of rec.pcm.splice(0)) rec.ws.send(frame);
    rec.ws.send(JSON.stringify({ type: 'stop', duration }));
  } else {
    await api(`/api/meetings/${rec.meeting.id}/stop`, { method: 'POST', body: { duration } }).catch(() => {});
  }

  // 2. Finish the audio file (everything was already streamed to disk while recording).
  let saved = await drainAudio(rec, 60000);
  if (saved) {
    try { await api(`/api/meetings/${rec.meeting.id}/audio-finish`, { method: 'POST', body: { size: rec.up.total } }); } catch { saved = false; }
  }
  if (!saved) alert('The recording was saved, but the very end of the audio could not be written. Everything up to the last few seconds is kept.');

  // 3. Wait for the server to flush the final transcript results.
  let m;
  for (let i = 0; i < 300; i++) { // on-device transcription may still be working through the last utterances
    m = await api(`/api/meetings/${rec.meeting.id}`);
    if (m.status !== 'recording') break;
    if (i === 4) main.replaceChildren(h('div', { class: 'wrap empty' }, 'Finishing the transcript… this can take a minute for long meetings.'));
    await new Promise((r) => setTimeout(r, 1000));
  }
  await openMeeting(rec.meeting.id, { autoSummarize: config.ai });
}

// During Stop, bring the live socket back once more (connectSocket is a no-op once stopping is set).
function connectSocketForStop(rec) {
  rec.stopping = false;
  connectSocket(rec);
  rec.stopping = true;
}

/* ----------------------------------------------------------------- detail */

async function openMeeting(id, { autoSummarize = false } = {}) {
  if (recording) return;
  currentId = id;
  refreshList();
  let m = await api(`/api/meetings/${id}`);
  spkOrder.clear();
  for (const sp of m.speakers || []) spkColor(sp.name); // colours follow order of first appearance
  let tab = 'summary';
  const audio = h('audio', { controls: 'controls', preload: 'metadata', src: m.hasAudio ? `/api/meetings/${id}/audio` : null });
  const body = h('div');
  const busy = { summarize: false };

  const titleInput = h('input', { value: m.title, class: 'grow', style: 'font-size:20px;font-weight:650',
    onchange: async () => { m = await api(`/api/meetings/${id}`, { method: 'PATCH', body: { title: titleInput.value } }); refreshList(); } });

  const tabBtn = (key, label) => h('button', { class: tab === key ? 'on' : '', onclick: () => { tab = key; draw(); } }, label);

  function draw() {
    drawCard();
    tabs.replaceChildren(tabBtn('summary', 'Summary'), tabBtn('transcript', 'Transcript'), tabBtn('ask', 'Ask'));
    body.replaceChildren(tab === 'summary' ? summaryView() : tab === 'transcript' ? transcriptView() : askView());
  }

  const cardHolder = h('div');
  const GENERIC = /^(Speaker \d+|You|Others)$/;
  function drawCard() {
    const sps = m.speakers || [];
    if (m.status === 'bot' || !sps.length) { cardHolder.replaceChildren(); return; }
    const unsure = m.transcript.filter((t) => t.uncertain).length;
    cardHolder.replaceChildren(h('div', { class: 'card spkcard' },
      h('div', { class: 'row' }, h('b', {}, `Speakers (${sps.length})`), h('span', { class: 'grow' }),
        m.hasVoiceprints ? h('button', { title: 'Re-compare every line with the final voice profiles', onclick: async () => { m = await api(`/api/meetings/${id}/refine`, { method: 'POST' }); draw(); } }, 'Re-check all') : null),
      ...sps.map((sp) => h('div', { class: 'sprow' },
        h('div', { class: 'spname' }, spkDot(sp.name), h('b', {}, sp.name)),
        h('div', { class: 'spbar', title: `${Math.round(sp.share * 100)}% of the talking` }, h('div', { style: `width:${Math.max(2, sp.share * 100)}%;background:${spkColor(sp.name)}` })),
        h('div', { class: 'muted spstat' }, `${fmt(sp.talkSec)} · ${Math.round(sp.share * 100)}% · ${sp.turns} turn${sp.turns === 1 ? '' : 's'} · ${sp.words} words`, sp.uncertain ? ` · ${sp.uncertain} unsure` : ''),
        h('button', { onclick: async () => {
          const to = prompt(`Rename “${sp.name}” to (use an existing name to merge two speakers):`, sp.name);
          if (to && to.trim() && to.trim() !== sp.name) { m = await api(`/api/meetings/${id}/rename-speaker`, { method: 'POST', body: { from: sp.name, to: to.trim() } }); spkOrder.clear(); for (const x of m.speakers) spkColor(x.name); draw(); }
        } }, 'Rename'),
        m.hasVoiceprints && !GENERIC.test(sp.name) ? h('button', { title: 'Save this person\'s voice on this computer so future meetings recognise them', onclick: async () => {
          if (!confirm(`Remember ${sp.name}'s voice on this computer?\n\nA voiceprint (a numeric fingerprint of their voice) is stored encrypted, locally, so later meetings can label them automatically. Only do this with their consent. You can delete it any time in Settings.`)) return;
          try { await api(`/api/meetings/${id}/remember-voice`, { method: 'POST', body: { speaker: sp.name } }); alert(`${sp.name}'s voice is saved. Future meetings will recognise them.`); }
          catch (e) { alert(e.message); }
        } }, 'Remember voice') : null)),
      unsure ? h('div', { class: 'notice', style: 'margin-top:10px' }, `${unsure} line${unsure === 1 ? ' is' : 's are'} marked “? unsure”: the app could not tell who spoke (overlapping voices, a very short reply, or noisy audio). Open the Transcript tab and click a name to fix it.`) : null));
  }

  async function summarize() {
    busy.summarize = true; draw();
    try { m = await api(`/api/meetings/${id}/summarize`, { method: 'POST' }); }
    catch (e) { alert(e.message); }
    busy.summarize = false; draw(); refreshList();
  }

  function summaryView() {
    if (!config.ai) return h('div', { class: 'notice' }, 'No summary model yet. Open ⚙ Settings and click “Download the summary model” (free, runs on this computer).');
    if (busy.summarize) return h('div', { class: 'muted' }, 'Summarizing…');
    const s = m.summary;
    if (!s) return h('div', {}, h('p', { class: 'muted' }, m.transcript.length ? 'No summary yet.' : 'No transcript to summarize.'),
      h('button', { class: 'primary', disabled: m.transcript.length ? null : 'disabled', onclick: summarize }, 'Generate summary'));
    return h('div', {},
      h('p', {}, s.summary),
      s.topics?.length ? [h('h2', {}, 'Topics'), h('div', { class: 'chips' }, s.topics.map((t) => h('span', { class: 'chip' }, t)))] : null,
      s.decisions?.length ? [h('h2', {}, 'Decisions'), h('ul', { class: 'bul' }, s.decisions.map((d) => h('li', {}, d)))] : null,
      s.actionItems?.length ? [h('h2', {}, 'Action items'), h('ul', { class: 'bul' }, s.actionItems.map((a) =>
        h('li', {}, a.task, a.owner ? h('span', { class: 'muted' }, ` — ${a.owner}`) : null, a.due ? h('span', { class: 'muted' }, ` (due ${a.due})`) : null)))] : null,
      s.speakers?.length ? [h('h2', {}, 'Who did what'), ...s.speakers.map((p) => h('div', { style: 'margin:8px 0' },
        h('div', {}, spkDot(p.name), h('b', {}, p.name), p.role ? h('span', { class: 'muted' }, ` — ${p.role}`) : null),
        p.points?.length ? h('ul', { class: 'bul' }, p.points.map((x) => h('li', {}, x))) : null))] : null,
      h('p', { class: 'muted', style: 'margin-top:18px' }, s.engine ? `Generated ${s.engine}. ` : '', h('button', { onclick: summarize }, 'Regenerate')));
  }

  const liveBot = () => m.localBot && m.status === 'recording';
  function transcriptView() {
    if (m.status === 'bot') return h('div', { class: 'muted' }, 'The transcript will appear here after the meeting ends.');
    if (liveBot() && !m.transcript.length) return h('div', { class: 'muted' }, 'Waiting for someone to speak. The transcript appears here live.');
    if (!m.transcript.length) return h('div', { class: 'muted' }, 'No transcript was captured.');
    const canFix = m.status !== 'bot' && !liveBot();
    const onPick = (seg) => pickSpeaker(seg, m.speakers || [], {
      onChoose: async (name) => { m = await api(`/api/meetings/${id}/segments/${seg.id}/speaker`, { method: 'POST', body: { speaker: name } }); spkOrder.clear(); for (const x of m.speakers) spkColor(x.name); draw(); },
      onRenameAll: async (from, to) => { m = await api(`/api/meetings/${id}/rename-speaker`, { method: 'POST', body: { from, to } }); spkOrder.clear(); for (const x of m.speakers) spkColor(x.name); draw(); },
    });
    const wrap = h('div', { onclick: (e) => {
      const t = e.target.closest('.ts');
      if (t && m.hasAudio) { audio.currentTime = Number(t.dataset.t); audio.play(); }
    } }, m.transcript.map((seg) => segRow(seg, canFix ? onPick : null)));
    const unsure = m.transcript.filter((t) => t.uncertain).length;
    let at = -1;
    const review = () => { // jump to the next uncertain line
      const rows = [...wrap.querySelectorAll('.seg.unsure')];
      if (!rows.length) return;
      at = (at + 1) % rows.length;
      rows[at].scrollIntoView({ block: 'center', behavior: 'smooth' });
      rows[at].classList.add('flash'); setTimeout(() => rows[at]?.classList.remove('flash'), 1600);
    };
    return h('div', {},
      h('div', { class: 'row', style: 'margin-bottom:8px' },
        h('span', { class: 'muted grow' }, 'Click a timestamp to play from there. Click a speaker name to change who said a line.'),
        unsure ? h('button', { onclick: review }, `Review ${unsure} unsure`) : null,
        h('button', { onclick: () => download(m, 'md') }, 'Export .md'),
        h('button', { onclick: () => download(m, 'txt') }, 'Export .txt')),
      wrap);
  }

  function askView() {
    if (!config.ai) return h('div', { class: 'notice' }, 'No summary model yet. Open ⚙ Settings and click “Download the summary model” (free, runs on this computer).');
    const q = h('input', { class: 'grow', placeholder: 'e.g. What did we decide about the launch date?' });
    const out = h('div', { class: 'qa' });
    const go = async () => {
      if (!q.value.trim()) return;
      out.textContent = 'Thinking…';
      try { out.textContent = (await api(`/api/meetings/${id}/ask`, { method: 'POST', body: { question: q.value } })).answer; }
      catch (e) { out.textContent = e.message; }
    };
    q.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    return h('div', {}, h('div', { class: 'row' }, q, h('button', { class: 'primary', onclick: go }, 'Ask')), out);
  }

  const tabs = h('div', { class: 'tabs' });
  main.replaceChildren(h('div', { class: 'wrap' },
    h('div', { class: 'row' }, titleInput,
      h('button', { class: 'danger', onclick: async () => {
        if (!confirm('Delete this meeting, its transcript and recording? This cannot be undone.')) return;
        await api(`/api/meetings/${id}`, { method: 'DELETE' });
        currentId = null; refreshList(); showRecorder();
      } }, 'Delete')),
    h('div', { class: 'muted' }, `${fmtDate(m.createdAt)} · ${m.status === 'bot' ? 'bot meeting' : fmt(m.durationSec)} · ${m.platform}`),
    liveBot() ? h('div', { class: 'notice row' },
      h('span', { class: 'grow' }, `Bot: ${BOT_LABELS[m.botStatus] || m.botStatus}${m.botNote ? ` — ${m.botNote}` : ''}`),
      h('button', { onclick: () => api(`/api/meetings/${id}/bot/show`, { method: 'POST' }).catch((err) => alert(err.message)) }, 'Show bot window'),
      h('button', { onclick: async (e) => { e.target.disabled = true; try { await api(`/api/meetings/${id}/leave`, { method: 'POST' }); } catch (err) { alert(err.message); e.target.disabled = false; } } }, 'Make bot leave')) : null,
    m.status === 'bot' ? h('div', { class: 'notice row' },
      h('span', { class: 'grow' }, `Bot status: ${BOT_LABELS[m.botStatus] || m.botStatus}`),
      h('button', { onclick: async (e) => { e.target.disabled = true; try { await api(`/api/meetings/${id}/leave`, { method: 'POST' }); } catch (err) { alert(err.message); e.target.disabled = false; } } }, 'Make bot leave')) : null,
    m.botError ? h('div', { class: 'notice' }, m.botError) : null,
    m.interrupted ? h('div', { class: 'notice' }, '⚠ This recording was cut off (the app, computer or connection stopped before Stop was pressed). Everything captured up to that point was recovered', m.audioPartial ? '; the audio may end abruptly.' : '.') : null,
    m.hasAudio ? audio : (m.status === 'bot' ? null : h('div', { class: 'muted' }, 'No audio saved.')),
    cardHolder, tabs, body));
  draw();
  if (autoSummarize && !m.summary && m.transcript.length) summarize();

  // A built-in bot meeting records live: refresh its status and transcript until it ends.
  if (liveBot()) {
    const watch = setInterval(async () => {
      if (currentId !== id || recording) return clearInterval(watch);
      try {
        const fresh = await api(`/api/meetings/${id}`);
        if (fresh.status !== 'recording') { clearInterval(watch); openMeeting(id, { autoSummarize: config.ai }); }
        else if (fresh.botStatus !== m.botStatus || fresh.botNote !== m.botNote) { clearInterval(watch); openMeeting(id); }
        else if (fresh.transcript.length !== m.transcript.length) { m = fresh; draw(); }
      } catch { clearInterval(watch); }
    }, 3000);
  }

  // A bot meeting changes on the server; watch it until it finishes, then reload the full view.
  if (m.status === 'bot') {
    const watch = setInterval(async () => {
      if (currentId !== id || recording) return clearInterval(watch);
      try {
        const fresh = await api(`/api/meetings/${id}`);
        if (fresh.status !== 'bot') { clearInterval(watch); openMeeting(id, { autoSummarize: config.ai }); }
        else if (fresh.botStatus !== m.botStatus) { clearInterval(watch); openMeeting(id); }
      } catch { clearInterval(watch); }
    }, 5000);
  }
}

function download(m, ext) {
  const lines = m.transcript.map((t) => ext === 'md' ? `**${t.speaker}** [${fmt(t.start)}]: ${t.text}\n` : `[${fmt(t.start)}] ${t.speaker}: ${t.text}`);
  let text = '';
  if (ext === 'md') {
    text = `# ${m.title}\n\n${fmtDate(m.createdAt)}\n\n`;
    if (m.summary) {
      text += `## Summary\n${m.summary.summary}\n\n`;
      if (m.summary.decisions?.length) text += `## Decisions\n${m.summary.decisions.map((d) => `- ${d}`).join('\n')}\n\n`;
      if (m.summary.actionItems?.length) text += `## Action items\n${m.summary.actionItems.map((a) => `- [ ] ${a.task}${a.owner ? ` (${a.owner})` : ''}`).join('\n')}\n\n`;
    }
    text += `## Transcript\n\n${lines.join('\n')}\n`;
  } else text = `${m.title}\n${fmtDate(m.createdAt)}\n\n${lines.join('\n')}\n`;
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: `${m.title.replace(/[^\w-]+/g, '_')}.${ext}` });
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ------------------------------------------------------------------- boot */

window.addEventListener('beforeunload', (e) => { if (recording) { e.preventDefault(); e.returnValue = ''; } });

(async () => {
  await loadConfig();
  await refreshList();
  showRecorder();
})();
