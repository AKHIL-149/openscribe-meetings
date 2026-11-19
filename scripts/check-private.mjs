// Safety net before publishing: fails if a file that could contain personal data or secrets is tracked/staged by git.
//   npm run check:private        (also installed as a pre-push hook by `npm run install-hooks`)
import { execFileSync } from 'child_process';
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const BAD = [/(^|\/)\.env($|\.)(?!example)/, /(^|\/)data\//, /\.enc$/, /vault\.key/, /voices\.json/, /meeting\.json$/, /\.(webm|wav|mp3|mp4|m4a|aiff)$/i, /\.gguf$/, /\.onnx$/, /bot-steps\.log$/, /\.log$/, /mr-test-profile/, /(^|\/)(Cookies|Local State|Network Persistent State)/];
const bad = files.filter((f) => BAD.some((re) => re.test(f)) && !/^\.env\.example$/.test(f));
if (bad.length) { console.error(`Refusing: these files may contain private data and must not be committed:\n  ${bad.join('\n  ')}`); process.exit(1); }
console.log(`ok: ${files.length} files, none look private`);
