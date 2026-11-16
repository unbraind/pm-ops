/** Synchronize real install workers and record their own install intervals. */
import { spawnSync } from '../subprocess.ts';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const [prefix, peersJson, cli, pin] = process.argv.slice(2);
const peers = JSON.parse(peersJson) as string[];
mkdirSync(dirname(prefix), { recursive: true });
writeFileSync(`${prefix}.ready`, 'ready');
const deadline = Date.now() + 60_000;
while (!peers.every(peer => existsSync(`${peer}.ready`))) {
  if (Date.now() >= deadline) throw new Error('install workers did not reach the ready barrier');
  await setTimeout(20);
}
const started = Date.now();
const result = spawnSync(process.execPath, [
  cli, 'install', '--prefix', prefix, `npm@${pin}`, '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(process.cwd(), 'cache'),
], { encoding: 'utf8', timeout: 240_000 });
const ended = Date.now();
writeFileSync(`${prefix}.timing.json`, JSON.stringify({ started, ended }));
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) process.stderr.write(String(result.error));
process.exitCode = result.status ?? 1;
