// Downloads an official Node.js binary (checksum-verified) for the speech engine, which cannot run
// inside Electron's own runtime. Usage: node scripts/fetch-node.mjs mac-arm64 win-x64
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const NODE_VERSION = '24.13.0';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'node');
const TARGETS = {
  'mac-arm64': { file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, inner: `node-v${NODE_VERSION}-darwin-arm64/bin/node`, out: 'node' },
  'win-x64': { file: `node-v${NODE_VERSION}-win-x64.zip`, inner: `node-v${NODE_VERSION}-win-x64/node.exe`, out: 'node.exe' },
};

for (const name of process.argv.slice(2)) {
  const t = TARGETS[name];
  if (!t) { console.error(`unknown target ${name}; choose from ${Object.keys(TARGETS)}`); process.exit(1); }
  const dest = path.join(root, name);
  if (fs.existsSync(path.join(dest, t.out))) { console.log(`node for ${name}: already present`); continue; }

  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums.split('\n').find((l) => l.endsWith(` ${t.file}`))?.split(/\s+/)[0];
  if (!expected) throw new Error(`no checksum listed for ${t.file}`);

  console.log(`downloading ${t.file} …`);
  const res = await fetch(`${base}/${t.file}`);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  if (actual !== expected) throw new Error(`checksum mismatch for ${t.file}: expected ${expected}, got ${actual}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-node-'));
  const archive = path.join(tmp, t.file);
  fs.writeFileSync(archive, buf);
  execFileSync('tar', ['-xf', archive, '-C', tmp, t.inner]); // bsdtar reads both .tar.gz and .zip
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(tmp, t.inner), path.join(dest, t.out));
  fs.chmodSync(path.join(dest, t.out), 0o755);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`node for ${name}: ok (sha256 verified)`);
}
