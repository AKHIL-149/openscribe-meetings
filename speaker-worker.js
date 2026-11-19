// Speaker-embedding process: turns an utterance's audio into a "voiceprint" vector (sherpa-onnx + TitaNet).
// A separate process under real Node, like the speech engine, so a fault here cannot crash the app.
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let extractor = null;
let diarizer = null;

process.on('disconnect', () => process.exit(0));
const post = (m) => process.send(m);

process.on('message', (m) => {
  try {
    if (m.type === 'load') {
      const sherpa = require('sherpa-onnx-node');
      extractor = new sherpa.SpeakerEmbeddingExtractor({ model: m.model, numThreads: 2, debug: false });
      // Segmentation (pyannote 3.0): finds who speaks when inside one utterance, including overlaps.
      diarizer = new sherpa.OfflineSpeakerDiarization({
        segmentation: { pyannote: { model: m.segModel }, numThreads: 2 },
        embedding: { model: m.model, numThreads: 2 },
        clustering: { numClusters: -1, threshold: 0.7 },
        minDurationOn: 0.3, minDurationOff: 0.3,
      });
      post({ type: 'ready', dim: extractor.dim });
    } else if (m.type === 'analyze') {
      const raw = Buffer.from(m.audio, 'base64');
      const samples = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
      const turns = diarizer.process(samples).map((t) => ({ start: t.start, end: t.end, spk: t.speaker }));
      post({ type: 'turns', jobId: m.jobId, turns });
    } else if (m.type === 'embed') {
      const raw = Buffer.from(m.audio, 'base64');
      const samples = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
      const stream = extractor.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples });
      const e = Float32Array.from(extractor.compute(stream));
      post({ type: 'embedding', jobId: m.jobId, emb: Buffer.from(e.buffer, e.byteOffset, e.byteLength).toString('base64') });
    }
  } catch (e) {
    post({ type: 'error', jobId: m.jobId, phase: m.type, message: String(e?.message || e) });
  }
});
