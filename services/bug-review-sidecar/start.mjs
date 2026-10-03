import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const directory = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(directory, '../../.env.local') });
dotenv.config({ path: path.resolve(directory, '../../.env') });
const args = process.argv.includes('--test') ? ['-m', 'pytest', '-q', 'tests'] : [
  '-m', 'uvicorn', 'bug_review.api:configured_app', '--factory', '--no-access-log', '--host', '127.0.0.1', '--port', process.env.BUG_REVIEW_SIDECAR_PORT || '8011'
];
const child = spawn(path.resolve(directory, '.venv/bin/python'), args, {
  cwd: directory, stdio: 'inherit', env: { ...process.env, PYTHONPATH: path.resolve(directory, 'src') }
});
child.on('error', () => { console.error('请按 services/bug-review-sidecar/README.md 创建 .venv 并安装依赖。'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
