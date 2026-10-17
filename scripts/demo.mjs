#!/usr/bin/env node
// End-to-end demo against the running Docker stack and the offline demo seeder:
//  1. magnet link  -> tc add --wait -> download link -> SHA-256 must match the seeded file
//  2. .torrent file + --zip -> download link -> archive size must match the reported size
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'demo', 'out');

function readEnv() {
  const env = {};
  for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

async function waitForFile(file, timeoutMs = 180_000) {
  const start = Date.now();
  while (!existsSync(file) || readFileSync(file, 'utf8').trim() === '') {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  return readFileSync(file, 'utf8').trim();
}

function tc(args, env) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [join(root, 'cli', 'dist', 'tc.js'), ...args, '--wait', '--json'], {
    env: { ...process.env, TC_API_TOKEN: env.TC_API_TOKEN, TC_API_URL: process.env.TC_API_URL ?? 'http://127.0.0.1:8080' },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`tc failed: ${res.stderr || res.stdout}`);
  return { job: JSON.parse(res.stdout), seconds: (Date.now() - started) / 1000 };
}

async function download(url) {
  const started = Date.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest('hex'), size, seconds: (Date.now() - started) / 1000 };
}

const mb = (bytes, seconds) => `${(bytes / 1048576).toFixed(1)} MB in ${seconds.toFixed(1)} s`;

async function main() {
  const env = readEnv();
  const magnet = await waitForFile(join(out, 'demo.magnet'));
  const expected = await waitForFile(join(out, 'demo.sha256'));
  let ok = true;

  console.log(`\n[1] magnet -> link\n    ${magnet.slice(0, 90)}...`);
  const first = tc(['add', magnet], env);
  console.log(`    job ${first.job.id}: ${first.job.status} after ${first.seconds.toFixed(1)} s`);
  const link = first.job.links[0];
  console.log(`    link: ${link?.url.split('?')[0]}?<signature>`);
  const got = await download(link.url);
  const match = got.sha256 === expected;
  ok &&= match;
  console.log(`    downloaded ${mb(got.size, got.seconds)}, sha256 ${match ? 'MATCHES' : 'DIFFERS'} (${got.sha256.slice(0, 16)}...)`);

  console.log('\n[2] .torrent file + --zip -> link');
  const second = tc(['add', join(out, 'demo.torrent'), '--zip'], env);
  console.log(`    job ${second.job.id}: ${second.job.status} after ${second.seconds.toFixed(1)} s`);
  const zipLink = second.job.links[0];
  const zip = await download(zipLink.url);
  const sizeOk = zip.size === zipLink.size && zipLink.name.endsWith('.zip');
  ok &&= sizeOk;
  console.log(`    ${zipLink.name}: downloaded ${mb(zip.size, zip.seconds)}, size ${sizeOk ? 'MATCHES' : 'DIFFERS'}`);

  console.log(`\nDEMO ${ok ? 'PASSED' : 'FAILED'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
