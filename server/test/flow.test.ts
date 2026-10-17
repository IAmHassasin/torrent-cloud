import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Aria2Error, type Aria2Client, type Aria2Status } from '../src/aria2.js';
import { loadConfig } from '../src/config.js';
import { LocalStorage } from '../src/storage/local.js';
import { JobStore } from '../src/store.js';
import { Worker } from '../src/worker.js';

const TOKEN = 't'.repeat(32);
const HASH = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c';

/** In-memory stand-in for aria2 driven by the test. */
class FakeAria2 {
  statuses = new Map<string, Aria2Status>();
  added: { gid: string; dir: string }[] = [];
  removed: string[] = [];
  private n = 0;

  async addUri(_uris: string[], options: Record<string, string>) {
    return this.add(options.dir!);
  }
  async addTorrent(_b64: string, options: Record<string, string>) {
    return this.add(options.dir!);
  }
  private add(dir: string) {
    const gid = `gid${++this.n}`;
    this.added.push({ gid, dir });
    this.set(gid, { status: 'active', dir, files: [{ index: '1', path: `[METADATA]${HASH}`, length: '0', completedLength: '0', selected: 'true' }] });
    return gid;
  }
  set(gid: string, patch: Partial<Aria2Status>) {
    const prev = this.statuses.get(gid);
    this.statuses.set(gid, {
      gid, status: 'active', totalLength: '0', completedLength: '0', downloadSpeed: '0', connections: '0', dir: '', files: [],
      ...prev, ...patch,
    });
  }
  async tellStatus(gid: string) {
    const s = this.statuses.get(gid);
    if (!s) throw new Aria2Error(`GID ${gid} is not found`, 1);
    return s;
  }
  async remove(gid: string) { this.removed.push(gid); }
  async removeDownloadResult() { return 'OK'; }
  async getVersion() { return { version: 'fake' }; }
}

describe('job flow (fake aria2 + local storage)', () => {
  let app: FastifyInstance;
  let aria2: FakeAria2;
  let worker: Worker;
  let downloads: string;
  const auth = { authorization: `Bearer ${TOKEN}` };

  beforeEach(async () => {
    const base = mkdtempSync(join(tmpdir(), 'tc-flow-'));
    downloads = join(base, 'downloads');
    const config = loadConfig({
      TC_API_TOKEN: TOKEN,
      ARIA2_RPC_SECRET: 's'.repeat(20),
      STORAGE_PROVIDER: 'local',
      LOCAL_LINK_SECRET: 'l'.repeat(32),
      DOWNLOAD_DIR: downloads,
      DATA_DIR: join(base, 'data'),
      PUBLIC_BASE_URL: 'http://localhost:8080',
    });
    const store = new JobStore(':memory:');
    aria2 = new FakeAria2();
    const storage = new LocalStorage(join(base, 'data', 'files'), config.PUBLIC_BASE_URL, config.LOCAL_LINK_SECRET!);
    await storage.init();
    worker = new Worker(config, store, aria2 as unknown as Aria2Client, storage, { error: () => undefined });
    app = await buildApp({ config, store, aria2: aria2 as unknown as Aria2Client, storage, worker });
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects requests without a valid token', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/jobs' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/jobs', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('validates the body', async () => {
    const bad = await app.inject({ method: 'POST', url: '/v1/jobs', headers: auth, payload: { magnet: 'http://evil.local/x' } });
    expect(bad.statusCode).toBe(400);
    const both = await app.inject({ method: 'POST', url: '/v1/jobs', headers: auth, payload: {} });
    expect(both.statusCode).toBe(400);
  });

  it('cannot bypass auth with percent-encoded paths', async () => {
    for (const url of ['/%761/jobs', '/v%31/jobs', '/%76%31/jobs']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).not.toBe(200);
      expect(res.body, url).not.toContain('"jobs"');
    }
    const post = await app.inject({ method: 'POST', url: '/%761/jobs', payload: { magnet: `magnet:?xt=urn:btih:${HASH}` } });
    expect(post.statusCode).not.toBe(201);
    expect(aria2.added).toHaveLength(0);
  });

  it('downloads a magnet, uploads it and serves a working link', async () => {
    const created = await app.inject({
      method: 'POST', url: '/v1/jobs', headers: auth,
      payload: { magnet: `magnet:?xt=urn:btih:${HASH}&dn=demo` },
    });
    expect(created.statusCode).toBe(201);
    const job = created.json();
    expect(job).toMatchObject({ status: 'queued', name: 'demo', infoHash: HASH });

    // Metadata finished -> real download continues in gid2.
    const { gid: metaGid, dir } = aria2.added[0]!;
    aria2.set(metaGid, { status: 'complete', followedBy: ['gid99'] });
    aria2.set('gid99', {
      status: 'active', dir, totalLength: '11', completedLength: '5', downloadSpeed: '100', connections: '1',
      bittorrent: { info: { name: 'demo' } },
      files: [{ index: '1', path: join(dir, 'demo', 'hello.txt'), length: '11', completedLength: '5', selected: 'true' }],
    });
    await worker.tick();
    await worker.tick();
    let current = (await app.inject({ method: 'GET', url: `/v1/jobs/${job.id}`, headers: auth })).json();
    expect(current.status).toBe('downloading');
    expect(current.progress.percent).toBe(45.4);

    mkdirSync(join(dir, 'demo'), { recursive: true });
    writeFileSync(join(dir, 'demo', 'hello.txt'), 'hello world');
    aria2.set('gid99', { status: 'complete', completedLength: '11' });
    await worker.tick();
    await worker.waitForUploads();

    current = (await app.inject({ method: 'GET', url: `/v1/jobs/${job.id}`, headers: auth })).json();
    expect(current.status).toBe('done');
    expect(current.files).toEqual([{ path: 'demo/hello.txt', size: 11 }]);
    expect(current.links).toHaveLength(1);
    const url = new URL(current.links[0].url);
    const file = await app.inject({ method: 'GET', url: url.pathname });
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe('hello world');

    const del = await app.inject({ method: 'DELETE', url: `/v1/jobs/${job.id}`, headers: auth });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: url.pathname })).statusCode).toBe(404);
  });

  it('marks jobs failed when aria2 reports an error or a file escapes the job dir', async () => {
    const a = (await app.inject({ method: 'POST', url: '/v1/jobs', headers: auth, payload: { magnet: `magnet:?xt=urn:btih:${HASH}` } })).json();
    aria2.set(aria2.added[0]!.gid, { status: 'error', errorMessage: 'No peers' });
    await worker.tick();
    expect((await app.inject({ method: 'GET', url: `/v1/jobs/${a.id}`, headers: auth })).json()).toMatchObject({ status: 'failed', error: 'No peers' });

    const b = (await app.inject({ method: 'POST', url: '/v1/jobs', headers: auth, payload: { magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}` } })).json();
    aria2.set(aria2.added[1]!.gid, {
      status: 'complete',
      files: [{ index: '1', path: join(downloads, 'other', 'x'), length: '1', completedLength: '1', selected: 'true' }],
    });
    await worker.tick();
    const stateB = (await app.inject({ method: 'GET', url: `/v1/jobs/${b.id}`, headers: auth })).json();
    expect(stateB).toMatchObject({ status: 'failed', error: 'Path escapes the download directory' });
  });
});
