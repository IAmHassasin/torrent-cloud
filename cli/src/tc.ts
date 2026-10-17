#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MAX_TORRENT_BYTES = 8 * 1024 * 1024;
const CONFIG_FILE = join(homedir(), '.config', 'torrent-cloud', 'config.json');

interface Link { name: string; size: number; url: string; expiresAt: string }
interface JobView {
  id: string;
  status: string;
  name: string | null;
  infoHash: string | null;
  progress: { totalBytes: number; completedBytes: number; percent: number; downloadSpeed: number; connections: number; uploadedBytes: number };
  links: Link[];
  error: string | null;
  createdAt: string;
}

const HELP = `tc - Torrent Cloud CLI

Usage:
  tc add <magnet | file.torrent | https://.../file.torrent> [--zip] [--wait] [--json]
  tc status <id> [--wait] [--json]
  tc ls [--json]
  tc rm <id>
  tc login --url <api-url> --token <token>

Environment (overrides the saved config):
  TC_API_URL    default http://127.0.0.1:8080
  TC_API_TOKEN  API token (see TC_API_TOKEN in the server .env)
`;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (['url', 'token'].includes(key) && next !== undefined) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function loadSettings(): { url: string; token: string } {
  let saved: { url?: string; token?: string } = {};
  if (existsSync(CONFIG_FILE)) saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as typeof saved;
  const url = process.env.TC_API_URL || saved.url || 'http://127.0.0.1:8080';
  const token = process.env.TC_API_TOKEN || saved.token || '';
  if (!token) throw new Error('No API token. Set TC_API_TOKEN or run "tc login --url <url> --token <token>".');
  return { url: url.replace(/\/$/, ''), token };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { url, token } = loadSettings();
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload as T;
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Turns the CLI argument into the API request body. */
export async function sourceToBody(source: string): Promise<{ magnet?: string; torrentBase64?: string }> {
  if (source.startsWith('magnet:')) return { magnet: source };
  let bytes: Buffer;
  if (/^https?:\/\//i.test(source)) {
    // The server never fetches URLs (no SSRF); the CLI downloads the .torrent and uploads it.
    const res = await fetch(source, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Could not download torrent: HTTP ${res.status}`);
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_TORRENT_BYTES) throw new Error('Torrent file is too large');
    bytes = Buffer.from(await res.arrayBuffer());
  } else {
    if (!existsSync(source)) throw new Error(`File not found: ${source}`);
    bytes = readFileSync(source);
  }
  if (bytes.length > MAX_TORRENT_BYTES) throw new Error('Torrent file is too large');
  return { torrentBase64: bytes.toString('base64') };
}

function describe(job: JobView): string {
  const p = job.progress;
  const parts = [`[${job.id}]`, job.status.padEnd(11), `${p.percent.toFixed(1).padStart(5)}%`];
  if (p.totalBytes) parts.push(`${formatBytes(p.completedBytes)}/${formatBytes(p.totalBytes)}`);
  if (job.status === 'downloading') parts.push(`${formatBytes(p.downloadSpeed)}/s`, `peers ${p.connections}`);
  if (job.status === 'uploading') parts.push(`uploaded ${formatBytes(p.uploadedBytes)}`);
  parts.push(job.name ?? job.infoHash ?? '');
  return parts.join('  ');
}

async function waitFor(id: string, json: boolean): Promise<JobView> {
  const tty = process.stderr.isTTY && !json;
  for (;;) {
    const job = await request<JobView>('GET', `/v1/jobs/${id}`);
    if (!json) {
      if (tty) process.stderr.write(`\r\x1b[2K${describe(job)}`);
      else process.stderr.write(`${describe(job)}\n`);
    }
    if (['done', 'failed', 'cancelled'].includes(job.status)) {
      if (tty) process.stderr.write('\n');
      return job;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

function printResult(job: JobView, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(job, null, 2));
  } else if (job.status === 'done') {
    for (const link of job.links) {
      console.error(`${link.name} (${formatBytes(link.size)}), expires ${link.expiresAt}`);
      console.log(link.url);
    }
  } else if (job.error) {
    console.error(`Error: ${job.error}`);
  }
  if (job.status === 'failed') process.exitCode = 1;
}

async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const [command, arg] = positional;
  const json = flags.has('json');

  switch (command) {
    case 'add': {
      if (!arg) throw new Error('Usage: tc add <magnet | file.torrent | url> [--zip] [--wait]');
      const body = { ...(await sourceToBody(arg)), zip: flags.has('zip') };
      const job = await request<JobView>('POST', '/v1/jobs', body);
      if (!flags.has('wait')) {
        if (json) console.log(JSON.stringify(job, null, 2));
        else console.log(`Queued job ${job.id}. Follow it with: tc status ${job.id} --wait`);
        return;
      }
      printResult(await waitFor(job.id, json), json);
      return;
    }
    case 'status': {
      if (!arg) throw new Error('Usage: tc status <id> [--wait]');
      const job = flags.has('wait') ? await waitFor(arg, json) : await request<JobView>('GET', `/v1/jobs/${arg}`);
      if (!flags.has('wait') && !json) console.error(describe(job));
      printResult(job, json);
      return;
    }
    case 'ls': {
      const { jobs } = await request<{ jobs: JobView[] }>('GET', '/v1/jobs');
      if (json) console.log(JSON.stringify(jobs, null, 2));
      else if (jobs.length === 0) console.log('No jobs.');
      else for (const job of jobs) console.log(describe(job));
      return;
    }
    case 'rm': {
      if (!arg) throw new Error('Usage: tc rm <id>');
      await request('DELETE', `/v1/jobs/${arg}`);
      console.log(`Removed ${arg}`);
      return;
    }
    case 'login': {
      const url = flags.get('url');
      const token = flags.get('token');
      if (typeof url !== 'string' || typeof token !== 'string') throw new Error('Usage: tc login --url <url> --token <token>');
      mkdirSync(dirname(CONFIG_FILE), { recursive: true });
      writeFileSync(CONFIG_FILE, JSON.stringify({ url, token }, null, 2), { mode: 0o600 });
      chmodSync(CONFIG_FILE, 0o600);
      console.log(`Saved to ${CONFIG_FILE}`);
      return;
    }
    default:
      console.log(HELP);
  }
}

const isEntry = process.argv[1] && /tc(\.js)?$/.test(process.argv[1]);
if (isEntry) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`tc: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
