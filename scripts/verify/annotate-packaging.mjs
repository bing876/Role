/** CI-only runner: GitHub's logs storage may be unreachable; publish a short redacted
 * failure excerpt as a check annotation (readable via the GitHub Checks API).
 * This never writes a branch, releases an installer, or outputs environment secrets.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const task = process.argv[2];
if (!['package:dir', 'verify:packaged-dir', 'package:win', 'package:mac'].includes(task))
  throw Error('Unknown packaging task');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', task], {
  cwd: root, env: process.env, windowsHide: true, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'],
});
const tail = [];
function relay(chunk, stream) {
  const text = chunk.toString();
  stream.write(text);
  tail.push(...text.split(/\r?\n/));
  if (tail.length > 50) tail.splice(0, tail.length - 50);
}
child.stdout.on('data', (chunk) => relay(chunk, process.stdout));
child.stderr.on('data', (chunk) => relay(chunk, process.stderr));
child.on('error', (error) => {
  tail.push(error.message);
});
child.on('close', (code, signal) => {
  if (code === 0) return;
  const lines = tail.filter((x) => /(?:Error:|error |failed|✗|⨯|assert|ENOENT|EACCES|spawn)/i.test(x));
  const detail = (lines.length ? lines : tail.filter(Boolean)).slice(-5).join(' | ')
    .replace(/https?:\/\/[^\s"']+\?[^\s"']+/g, '<signed-url>')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/(API_KEY|PASSWORD|SECRET|TOKEN)\s*[:=]\s*[^\s"']+/gi, '$1=[redacted]')
    .replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A').slice(0, 1800);
  console.error(`::error title=${task} failed::${detail || `exit ${code ?? signal}`}`);
  process.exitCode = code || 1;
});
