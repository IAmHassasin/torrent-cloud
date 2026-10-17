import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Aria2Client, Aria2Status } from '../src/aria2.js';
import { loadConfig } from '../src/config.js';
import type { Job } from '../src/jobs.js';
import type { StorageProvider } from '../src/storage/provider.js';
import { JobStore } from '../src/store.js';
import { Worker } from '../src/worker.js';

/** Storage that accepts the first upload and fails the second one. */
class FlakyStorage implements StorageProvider {
  readonly name = 'flaky';
  readonly stored = new Set<string>();
  readonly deleted: string[] = [];
  private puts = 0;
  async init() {}
  async put(_local: string, key: string) {
    if (++this.puts === 2) throw new Error('network down');
    this.stored.add(key);
  }
  async link(key: string) {
    return `http://x/${key}`;
  }
  async delete(key: string) {
    this.deleted.push(key);
    this.stored.delete(key);
  }
}

describe('upload failure', () => {
  it('fails the job and removes partial uploads and local files', async () => {
    const base = mkdtempSync(join(tmpdir(), 'tc-fail-'));
    const config = loadConfig({
      TC_API_TOKEN: 't'.repeat(32), ARIA2_RPC_SECRET: 's'.repeat(20), STORAGE_PROVIDER: 'local',
      LOCAL_LINK_SECRET: 'l'.repeat(32), DOWNLOAD_DIR: join(base, 'downloads'), DATA_DIR: join(base, 'data'),
    });
    const store = new JobStore(':memory:');
    const storage = new FlakyStorage();
    const dir = join(config.DOWNLOAD_DIR, 'abcdefabcdef');
    mkdirSync(join(dir, 'pack'), { recursive: true });
    writeFileSync(join(dir, 'pack', 'a.txt'), 'a');
    writeFileSync(join(dir, 'pack', 'b.txt'), 'b');
    const status: Aria2Status = {
      gid: 'g1', status: 'complete', totalLength: '2', completedLength: '2', downloadSpeed: '0', connections: '0', dir,
      files: ['a', 'b'].map((n, i) => ({ index: String(i + 1), path: join(dir, 'pack', `${n}.txt`), length: '1', completedLength: '1', selected: 'true' as const })),
    };
    const aria2 = { tellStatus: async () => status, removeDownloadResult: async () => 'OK' } as unknown as Aria2Client;
    const worker = new Worker(config, store, aria2, storage, { error: () => undefined });

    const now = new Date().toISOString();
    const job: Job = {
      id: 'abcdefabcdef', status: 'downloading', source: 'magnet', name: 'pack', gid: 'g1', infoHash: null, zip: false,
      totalBytes: 0, completedBytes: 0, downloadSpeed: 0, connections: 0, numSeeders: 0, uploadedBytes: 0,
      files: [], objects: [], error: null, createdAt: now, updatedAt: now, finishedAt: null,
    };
    store.insert(job);
    await worker.tick();
    await worker.waitForUploads();

    expect(store.get(job.id)).toMatchObject({ status: 'failed', error: 'Upload failed: network down' });
    expect(storage.stored.size).toBe(0);
    expect(storage.deleted).toContain('abcdefabcdef/pack/b.txt'); // the item that failed is cleaned up too
    expect(existsSync(dir)).toBe(false);
  });
});
