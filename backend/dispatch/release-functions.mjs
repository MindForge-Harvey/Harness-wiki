import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';

const vendor = new URL('./vendor/release-v1.3.2/', import.meta.url);
export const releaseSource = JSON.parse(fs.readFileSync(new URL('manifest.json', vendor), 'utf8'));
for (const row of releaseSource.files.filter(row => row.integration === 'vendored_original')) {
  const name = row.path.split('/').at(-1);
  if (crypto.createHash('sha256').update(fs.readFileSync(new URL(name, vendor))).digest('hex') !== row.sha256) throw new Error('发布包源函数校验失败：' + name);
}
export function runReleaseFunction(operation, input, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.DISPATCH_PYTHON || 'python3', ['-B', fileURLToPath(new URL('./release-worker.py', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'pipe'], signal, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
    });
    let output = '', stderr = '', settled = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    child.stdout.on('data', data => { output += data; if (output.length > 512000) child.kill('SIGKILL'); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (code !== 0) return finish(new Error(stderr || '发布包规则函数超时或执行失败'));
      try { finish(null, JSON.parse(output)); } catch { finish(new Error('发布包规则函数返回了无效 JSON')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ operation, ...input }));
  });
}
