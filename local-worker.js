// Runs Whisper in its own process so a crash or heavy load there can never take down the app or block the server.
import { pipeline, env } from '@huggingface/transformers';

let asr = null;
let multilingual = false;

process.on('disconnect', () => process.exit(0)); // parent went away
const post = (msg) => process.send(msg);

process.on('message', async (m) => {
  try {
    if (m.type === 'load') {
      if (process.env.MR_DEBUG) console.log(`[engine] loading ${m.id}`);
      env.cacheDir = m.cacheDir;
      if (asr?.dispose) await asr.dispose().catch(() => {});
      asr = null;
      asr = await pipeline('automatic-speech-recognition', m.id, {
        dtype: m.dtype || 'q8',
        device: 'cpu',
        progress_callback: (p) => post({ type: 'progress', p }),
      });
      multilingual = Boolean(m.multilingual);
      if (process.env.MR_DEBUG) console.log('[engine] ready');
      post({ type: 'ready' });
    } else if (m.type === 'run') {
      const t = Date.now();
      const opts = multilingual ? { task: 'transcribe', ...(m.lang && m.lang !== 'auto' ? { language: m.lang } : {}) } : {};
      const raw = Buffer.from(m.audio, 'base64');
      const audio = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
      if (process.env.MR_DEBUG) console.log(`[engine] transcribing ${(audio.length / 16000).toFixed(1)}s`);
      const out = await asr(audio, opts);
      post({ type: 'result', jobId: m.jobId, text: (out.text || '').trim(), ms: Date.now() - t });
    }
  } catch (e) {
    post({ type: 'error', jobId: m.jobId, phase: m.type, message: String(e?.message || e) });
  }
});
