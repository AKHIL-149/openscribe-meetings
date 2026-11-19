// Safe way to run the desktop app in a test: a brand-new throwaway profile, and it only ever stops the
// process it started itself. It never touches ~/Library/Application Support, never kills other copies.
//   node scripts/e2e-electron.mjs <page-script.js> [path/to/app/binary] [--keep] [--env KEY=VAL ...]
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const script = args.find((a) => !a.startsWith('--') && a.endsWith('.js') && fs.existsSync(a));
const bin = args.find((a) => a !== script && !a.startsWith('--') && !a.includes('=') && fs.existsSync(a));
const keep = args.includes('--keep');
const extraEnv = Object.fromEntries(args.filter((a, i) => args[i - 1] === '--env').map((kv) => [kv.split('=')[0], kv.slice(kv.indexOf('=') + 1)]));
if (!script) { console.error('usage: node scripts/e2e-electron.mjs <page-script.js> [app-binary] [--keep] [--env K=V]'); process.exit(1); }

const profile = process.env.MR_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'mr-e2e-profile-'));
// Launch the real Electron binary directly: `.bin/electron` is a wrapper, and killing the wrapper would leave the app running.
const cmd = bin || createRequire(import.meta.url)('electron');
const child = spawn(cmd, bin ? [] : [root], {
  env: { ...process.env, MR_USER_DATA: profile, MR_E2E_SCRIPT: path.resolve(script), ...extraEnv },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
child.stderr.on('data', (d) => { if (!/WARNING|ERROR:/.test(d)) process.stderr.write(d); });
// --kill-when-audio-bytes N: simulate a crash. Once the encrypted recording in OUR throwaway profile reaches
// N bytes, SIGKILL the app we started (never any other process).
const killAt = Number((args.find((a, i) => args[i - 1] === '--kill-when-audio-bytes')) || 0);
if (killAt) {
  const poll = setInterval(() => {
    try {
      const mdir = path.join(profile, 'data', 'meetings');
      for (const id of fs.readdirSync(mdir)) {
        const f = path.join(mdir, id, 'audio.webm.enc');
        if (fs.existsSync(f) && fs.statSync(f).size >= killAt) { clearInterval(poll); console.log(`[runner] audio reached ${fs.statSync(f).size} bytes: SIGKILL the app (simulated crash)`); child.kill('SIGKILL'); }
      }
    } catch { /* not created yet */ }
  }, 400);
  child.on('exit', () => clearInterval(poll));
}
const timer = setTimeout(() => { console.error('timeout: stopping the test app'); child.kill('SIGTERM'); }, Number(process.env.MR_E2E_TIMEOUT_MS) || 9 * 60 * 1000);
child.on('exit', (code) => {
  clearTimeout(timer);
  if (!keep && profile.startsWith(os.tmpdir()) && path.basename(profile).startsWith('mr-e2e-profile-')) fs.rmSync(profile, { recursive: true, force: true }); // only our own temp profile
  else console.log(`profile kept at ${profile}`);
  process.exit(code ?? 0);
});
