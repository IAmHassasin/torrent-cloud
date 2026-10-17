import { createHmac, timingSafeEqual } from 'node:crypto';
import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveInside } from '../paths.js';
import type { StorageProvider, UploadProgress } from './provider.js';

interface LinkPayload {
  k: string;
  n: string;
  e: number;
}

/**
 * Keeps files on the worker disk and serves them from the API with HMAC-signed, expiring links.
 * Useful when no object storage is available; bandwidth is limited by the worker.
 */
export class LocalStorage implements StorageProvider {
  readonly name = 'local';

  constructor(
    private readonly root: string,
    private readonly publicBaseUrl: string,
    private readonly secret: string,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async put(localPath: string, key: string, size: number, onProgress?: UploadProgress): Promise<void> {
    const target = resolveInside(this.root, key);
    await mkdir(dirname(target), { recursive: true });
    try {
      await rename(localPath, target);
    } catch {
      // Different volumes: fall back to copy.
      await copyFile(localPath, target);
    }
    onProgress?.(size);
  }

  async link(key: string, fileName: string, ttlSec: number): Promise<string> {
    const payload: LinkPayload = { k: key, n: fileName, e: Math.floor(Date.now() / 1000) + ttlSec };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${this.publicBaseUrl.replace(/\/$/, '')}/files/${body}.${this.sign(body)}`;
  }

  /** Validates a link token and returns the absolute file path and download name. */
  verify(token: string): { path: string; fileName: string } | null {
    const [body, signature] = token.split('.');
    if (!body || !signature) return null;
    const expected = Buffer.from(this.sign(body));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    let payload: LinkPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LinkPayload;
    } catch {
      return null;
    }
    if (typeof payload.e !== 'number' || payload.e < Date.now() / 1000) return null;
    try {
      return { path: resolveInside(this.root, payload.k), fileName: payload.n };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(resolveInside(this.root, key), { force: true });
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}
