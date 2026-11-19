// Runs the bundled language model (llama.cpp via node-llama-cpp) in its own process, under real Node.js,
// so a crash or out-of-memory in the model can never take the app down. Messages are plain JSON over IPC.
import { getLlama, LlamaChatSession } from 'node-llama-cpp';

let llama = null, model = null, context = null, jsonGrammar = null;
const send = (m) => process.send?.(m);

async function load({ file, ctx }) {
  llama = await getLlama({ logLevel: 'error' });
  model = await llama.loadModel({ modelPath: file });
  // Ask for the context we want; llama.cpp shrinks it to whatever fits in free memory instead of failing.
  context = await model.createContext({ contextSize: { min: 4096, max: ctx } });
  jsonGrammar = await llama.getGrammarFor('json');
  send({ t: 'loaded', contextSize: context.contextSize, gpu: llama.gpu || false });
}

async function chat({ id, system, user, json, maxTokens }) {
  const seq = context.getSequence();
  try {
    const session = new LlamaChatSession({ contextSequence: seq, systemPrompt: system });
    const text = await session.prompt(user, { maxTokens, temperature: 0.2, ...(json ? { grammar: jsonGrammar } : {}) });
    send({ t: 'done', id, text });
  } finally { seq.dispose(); }
}

process.on('message', async (msg) => {
  try {
    if (msg.t === 'load') await load(msg);
    else if (msg.t === 'chat') await chat(msg);
  } catch (e) { send({ t: 'error', id: msg.id, message: String(e?.message || e) }); }
});
process.on('disconnect', () => process.exit(0));
send({ t: 'hello' });
