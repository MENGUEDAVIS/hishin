import { spawnSync } from 'node:child_process';

const major = Number(process.versions.node.split('.')[0]);
let missing = major !== 24;
console.log(`${major === 24 ? 'OK' : 'MISSING'} Node.js 24 (${process.version})`);
for (const [name, executable, args, required] of [
  ['FFmpeg', process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], true],
  ['FFprobe', process.env.FFPROBE_PATH || 'ffprobe', ['-version'], true],
  ['AWS CLI', 'aws', ['--version'], false],
]) {
  if (typeof executable !== 'string' || !Array.isArray(args)) throw new Error('Invalid setup check');
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 10000, shell: false });
  const ok = !result.error && result.status === 0;
  console.log(`${ok ? 'OK' : required ? 'MISSING' : 'OPTIONAL'} ${name}`);
  if (!ok && required) missing = true;
}
if (missing) console.error('Install Node.js 24 and FFmpeg (including ffprobe), then run this check again.');
process.exitCode = missing ? 1 : 0;
