import { mkdir, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import archiver from 'archiver';
import { Aria2Error, type Aria2Client, type Aria2Status } from './aria2.js';
import type { Config } from './config.js';
import { isTerminal, type Job, type JobFile, type StoredObject } from './jobs.js';
import { resolveInside, sanitizeKeyPath, toPosixRelative } from './paths.js';
import type { StorageProvider } from './storage/index.js';
import type { JobStore } from './store.js';

const METADATA_PREFIX = '[METADATA]';

export interface WorkerLogger {
  error(obj: object, msg: string): void;
}

/** Polls aria2, moves jobs through their lifecycle and uploads finished downloads. */
export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private readonly uploading = new Set<string>();
  private stopped = false;

  constructor(
    private readonly config: Config,
    private readonly store: JobStore,
    private readonly aria2: Aria2Client,
    private readonly storage: StorageProvider,
    private readonly log: WorkerLogger,
  ) {}

  jobDir(id: string): string {
    return join(this.config.DOWNLOAD_DIR, id);
  }

  start(): void {
    this.stopped = false;
    const loop = async () => {
      try {
        await this.tick();
      } catch (err) {
        this.log.error({ err }, 'worker tick failed');
      }
      if (!this.stopped) this.timer = setTimeout(loop, this.config.POLL_INTERVAL_MS);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** One polling round. Exposed for tests. */
  async tick(): Promise<void> {
    for (const job of this.store.listByStatus(['queued', 'downloading'])) {
      await this.syncDownload(job);
    }
    for (const job of this.store.listByStatus(['uploading'])) {
      if (!this.uploading.has(job.id)) this.startUpload(job);
    }
  }

  async waitForUploads(): Promise<void> {
    while (this.uploading.size > 0) await new Promise((r) => setTimeout(r, 20));
  }

  private async syncDownload(job: Job): Promise<void> {
    if (!job.gid) return;
    let status: Aria2Status;
    try {
      status = await this.aria2.tellStatus(job.gid);
    } catch (err) {
      if (err instanceof Aria2Error && /not found/i.test(err.message)) {
        this.fail(job, 'Download was lost by the torrent engine');
        return;
      }
      throw err;
    }
    if (!this.store.get(job.id)) return; // removed while we were waiting for aria2

    // Magnet links: aria2 first fetches metadata, then continues in a new gid.
    const next = status.followedBy?.[0];
    if (next) {
      this.store.update(job.id, { gid: next, status: 'downloading' });
      await this.aria2.removeDownloadResult(job.gid).catch(() => undefined);
      return;
    }

    const isMetadata = status.files[0]?.path.startsWith(METADATA_PREFIX) ?? false;
    const progress: Partial<Job> = {
      name: status.bittorrent?.info?.name ?? job.name,
      infoHash: status.infoHash ?? job.infoHash,
      totalBytes: isMetadata ? 0 : Number(status.totalLength),
      completedBytes: isMetadata ? 0 : Number(status.completedLength),
      downloadSpeed: Number(status.downloadSpeed),
      connections: Number(status.connections),
      numSeeders: Number(status.numSeeders ?? 0),
    };

    switch (status.status) {
      case 'active':
      case 'waiting':
      case 'paused':
        this.store.update(job.id, { ...progress, status: 'downloading' });
        return;
      case 'error':
        this.fail(job, status.errorMessage || `Torrent engine error ${status.errorCode ?? ''}`.trim());
        return;
      case 'removed':
        this.store.update(job.id, { status: 'cancelled', finishedAt: new Date().toISOString() });
        return;
      case 'complete': {
        if (isMetadata) return; // follow-up gid not published yet
        let files: JobFile[];
        try {
          files = this.collectFiles(job, status);
        } catch (err) {
          this.fail(job, err instanceof Error ? err.message : String(err));
          return;
        }
        const updated = this.store.update(job.id, { ...progress, files, downloadSpeed: 0, status: 'uploading' });
        this.startUpload(updated);
        return;
      }
    }
  }

  private collectFiles(job: Job, status: Aria2Status): JobFile[] {
    const root = this.jobDir(job.id);
    return status.files
      .filter((f) => f.selected === 'true' && f.path !== '')
      .map((f) => {
        const absolute = resolveInside(root, f.path); // rejects paths outside the job directory
        return { path: toPosixRelative(root, absolute), size: Number(f.length) };
      });
  }

  private startUpload(job: Job): void {
    this.uploading.add(job.id);
    this.upload(job)
      .catch((err: unknown) => {
        this.log.error({ err, jobId: job.id }, 'upload failed');
        this.fail(job, `Upload failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => this.uploading.delete(job.id));
  }

  private async upload(job: Job): Promise<void> {
    const root = this.jobDir(job.id);
    const items: { local: string; name: string; size: number; key: string }[] = [];

    if (!job.zip) {
      for (const file of job.files) {
        items.push({
          local: resolveInside(root, file.path),
          name: file.path.split('/').pop() ?? file.path,
          size: file.size,
          key: `${job.id}/${sanitizeKeyPath(file.path)}`,
        });
      }
    }

    const objects: StoredObject[] = [];
    let doneBytes = 0;
    let lastReport = 0;
    try {
      if (job.zip) {
        const zipName = `${job.name ?? job.id}.zip`;
        const zipPath = join(this.config.DOWNLOAD_DIR, '.zips', `${job.id}.zip`);
        await this.zip(root, job.files, zipPath);
        const { size } = await stat(zipPath);
        items.push({ local: zipPath, name: zipName, size, key: `${job.id}/${sanitizeKeyPath(zipName)}` });
      }
      for (const item of items) {
        // Registered before the upload so a half-finished object is deleted on failure too.
        objects.push({ name: item.name, key: item.key, size: item.size });
        await this.storage.put(item.local, item.key, item.size, (loaded) => {
          const now = Date.now();
          if (now - lastReport < 1000 || !this.store.get(job.id)) return;
          lastReport = now;
          this.store.update(job.id, { uploadedBytes: doneBytes + loaded });
        });
        doneBytes += item.size;
      }
    } catch (err) {
      // Do not leave orphaned objects or local files behind when an upload fails half way.
      await this.discard(job.id, objects);
      throw err;
    }

    if (!this.store.get(job.id)) {
      // Job was removed while uploading.
      await this.discard(job.id, objects);
      return;
    }
    this.store.update(job.id, {
      status: 'done',
      objects,
      uploadedBytes: doneBytes,
      finishedAt: new Date().toISOString(),
    });
    if (job.gid) await this.aria2.removeDownloadResult(job.gid).catch(() => undefined);
    if (!this.config.KEEP_LOCAL) await this.cleanupLocal(job.id);
  }

  private async zip(root: string, files: JobFile[], target: string): Promise<void> {
    await mkdir(join(target, '..'), { recursive: true });
    await new Promise<void>((resolvePromise, reject) => {
      const output = createWriteStream(target);
      // Store only: torrent payloads are usually already compressed; speed matters more.
      const archive = archiver('zip', { store: true });
      output.on('close', () => resolvePromise());
      output.on('error', reject);
      archive.on('error', reject);
      archive.pipe(output);
      for (const file of files) archive.file(resolveInside(root, file.path), { name: file.path });
      void archive.finalize();
    });
  }

  /** Stops the download if running, deletes local files and stored objects, then the job record. */
  async remove(id: string): Promise<boolean> {
    const job = this.store.get(id);
    if (!job) return false;
    this.store.delete(id); // an in-flight upload notices this and deletes what it uploaded
    if (job.gid && !isTerminal(job.status)) await this.aria2.remove(job.gid);
    await Promise.all(job.objects.map((o) => this.storage.delete(o.key)));
    await this.cleanupLocal(id);
    return true;
  }

  private async discard(id: string, objects: StoredObject[]): Promise<void> {
    const results = await Promise.allSettled(objects.map((o) => this.storage.delete(o.key)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) this.log.error({ jobId: id, failed }, 'could not delete uploaded objects');
    if (!this.config.KEEP_LOCAL) await this.cleanupLocal(id);
  }

  private async cleanupLocal(id: string): Promise<void> {
    await rm(this.jobDir(id), { recursive: true, force: true });
    await rm(join(this.config.DOWNLOAD_DIR, '.zips', `${id}.zip`), { force: true });
  }

  private fail(job: Job, message: string): void {
    if (!this.store.get(job.id)) return;
    this.store.update(job.id, { status: 'failed', error: message, finishedAt: new Date().toISOString() });
  }
}
