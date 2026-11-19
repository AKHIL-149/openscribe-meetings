// The speaker engine needs sherpa-onnx's native library for the target OS. npm only installs the one for
// the machine you build on, so for cross-builds this fetches the other one straight from the npm registry.
// Usage: node scripts/fetch-sherpa.mjs win-x64     (skips if already installed)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'sherpa-onnx-node', 'package.json'), 'utf8'));
const PKG = { 'win-x64': 'sherpa-onnx-win-x64', 'mac-arm64': 'sherpa-onnx-darwin-arm64' };

for (const target of process.argv.slice(2)) {
  const name = PKG[target];
  if (!name) throw new Error(`unknown target ${target}`);
  const dest = path.join(root, 'node_modules', name);
  if (fs.existsSync(path.join(dest, 'package.json'))) { console.log(`${name}: already installed`); continue; }
  const version = pkgJson.optionalDependencies?.[name] || pkgJson.version;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-sherpa-'));
  const out = execFileSync('npm', ['pack', `${name}@${version}`, '--silent', '--pack-destination', tmp], { encoding: 'utf8' }).trim().split('\n').pop();
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('tar', ['-xzf', path.join(tmp, out), '-C', dest, '--strip-components=1']);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${name}@${version}: installed for cross-build`);
}
