// Encrypted-at-rest storage for meetings, settings and recordings.
//
//  * Master key: 32 random bytes. In the desktop app it is protected by the OS (macOS Keychain /
//    Windows DPAPI via Electron safeStorage) and handed to us in MR_MASTER_KEY. When running as a plain
//    Node server it lives in <data>/vault.key (mode 0600), which protects against casual copying of the
//    data folder but not against someone who can read both files.
//  * JSON (meeting records, settings incl. API keys): AES-256-GCM, authenticated, so tampering is detected.
//  * Recordings: AES-256-CTR with a random per-file IV. CTR is seekable, so audio playback can still
//    jump around; it is not authenticated (a modified recording would play back as noise, not be detected).
//  * Separate sub-keys are derived from the master key with HKDF for JSON and media.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

const MAGIC = Buffer.from('MRV1');
const IV_LEN = 12, TAG_LEN = 16, CTR_IV_LEN = 16;
const FILE_MODE = 0o600, DIR_MODE = 0o700;

let jsonKey = null, mediaKey = null;
let source = 'uninitialised';

export const vaultInfo = () => ({ encrypted: Boolean(jsonKey), keySource: source });

const derive = (master, label) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), `meeting-recorder/${label}`, 32));

export function initVault(dataRoot) {
  let master;
  const fromHost = process.env.MR_MASTER_KEY;
  delete process.env.MR_MASTER_KEY; // do not leave the key in the environment
  if (fromHost) {
    master = Buffer.from(fromHost, 'hex');
    source = process.env.MR_MASTER_KEY_SOURCE || 'os-keychain';
  } else {
    const keyFile = path.join(dataRoot, 'vault.key');
    if (fs.existsSync(keyFile)) master = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
    else {
      master = crypto.randomBytes(32);
      fs.writeFileSync(keyFile, master.toString('hex'), { mode: FILE_MODE });
    }
    source = 'key-file';
  }
  if (master.length !== 32) throw new Error('Vault key must be 32 bytes');
  jsonKey = derive(master, 'json');
  mediaKey = derive(master, 'media');
}

export const ensureDir = (d) => fs.mkdirSync(d, { recursive: true, mode: DIR_MODE });

/* ------------------------------------------------------------------ JSON */

export function sealJSON(obj) {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', jsonKey, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}

export function openJSON(buf) {
  const iv = buf.subarray(4, 4 + IV_LEN);
  const tag = buf.subarray(4 + IV_LEN, 4 + IV_LEN + TAG_LEN);
  const d = crypto.createDecipheriv('aes-256-gcm', jsonKey, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(buf.subarray(4 + IV_LEN + TAG_LEN)), d.final()]).toString('utf8'));
}

/** Returns { obj, legacy } where legacy=true means the file was still plaintext and should be re-saved. */
export function readJSON(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 4).equals(MAGIC)) return { obj: openJSON(buf), legacy: false };
  return { obj: JSON.parse(buf.toString('utf8')), legacy: true };
}

export function writeJSON(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, sealJSON(obj), { mode: FILE_MODE });
  fs.renameSync(tmp, file);
}

/* ----------------------------------------------------------------- media */

/** Encrypt a readable stream into `file` (16-byte IV header + AES-256-CTR ciphertext). */
export async function encryptTo(readable, file) {
  const iv = crypto.randomBytes(CTR_IV_LEN);
  const tmp = `${file}.tmp`;
  const out = fs.createWriteStream(tmp, { mode: FILE_MODE });
  out.write(iv);
  try {
    await pipeline(readable, crypto.createCipheriv('aes-256-ctr', mediaKey, iv), out);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.renameSync(tmp, file);
}

export const plainSize = (file) => Math.max(0, fs.statSync(file).size - CTR_IV_LEN);

/** Decrypting read stream over bytes [start, end] (inclusive) of the plaintext. */
export function decryptRange(file, start = 0, end = Infinity) {
  const fd = fs.openSync(file, 'r');
  const iv = Buffer.alloc(CTR_IV_LEN);
  fs.readSync(fd, iv, 0, CTR_IV_LEN, 0);
  fs.closeSync(fd);

  const skip = start % 16;
  const blockStart = start - skip;
  const counter = (BigInt(`0x${iv.toString('hex')}`) + BigInt(blockStart / 16)) & ((1n << 128n) - 1n);
  const ivAtBlock = Buffer.from(counter.toString(16).padStart(32, '0'), 'hex');

  const src = fs.createReadStream(file, { start: CTR_IV_LEN + blockStart, end: Number.isFinite(end) ? CTR_IV_LEN + end : undefined });
  const decipher = crypto.createDecipheriv('aes-256-ctr', mediaKey, ivAtBlock);
  let toDrop = skip;
  const dropper = new Transform({
    transform(chunk, _enc, cb) {
      if (toDrop) { const n = Math.min(toDrop, chunk.length); toDrop -= n; chunk = chunk.subarray(n); }
      cb(null, chunk);
    },
  });
  src.on('error', (e) => dropper.destroy(e));
  return src.pipe(decipher).pipe(dropper);
}

/* ------------------------------------------------- append-only media (crash-safe) */

// AES-CTR can continue from any byte offset, so a recording can be written chunk by chunk while it is
// being made. Each append is flushed to disk; a crash loses at most the chunk in flight, and the file
// stays decryptable (and playable up to that point).
function ctrAt(iv, offset) {
  const skip = offset % 16;
  const counter = (BigInt(`0x${iv.toString('hex')}`) + BigInt((offset - skip) / 16)) & ((1n << 128n) - 1n);
  const c = crypto.createCipheriv('aes-256-ctr', mediaKey, Buffer.from(counter.toString(16).padStart(32, '0'), 'hex'));
  if (skip) c.update(Buffer.alloc(skip)); // advance within the block
  return c;
}

/** Plaintext bytes stored so far (0 if the file does not exist yet). */
export const storedSize = (file) => (fs.existsSync(file) ? plainSize(file) : 0);

/** Append plaintext to an encrypted media file, creating it if needed. Returns the new plaintext size. */
export function appendEncrypted(file, buf) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(CTR_IV_LEN), { mode: FILE_MODE });
  const fd = fs.openSync(file, 'r+');
  try {
    const iv = Buffer.alloc(CTR_IV_LEN);
    fs.readSync(fd, iv, 0, CTR_IV_LEN, 0);
    const size = Math.max(0, fs.fstatSync(fd).size - CTR_IV_LEN);
    const enc = ctrAt(iv, size).update(buf);
    fs.writeSync(fd, enc, 0, enc.length, CTR_IV_LEN + size); // explicit position: safe even after a torn write
    fs.fsyncSync(fd);
    return size + buf.length;
  } finally { fs.closeSync(fd); }
}
