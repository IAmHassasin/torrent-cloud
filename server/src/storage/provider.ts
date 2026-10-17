export interface UploadProgress {
  (uploadedBytes: number): void;
}

export interface StorageProvider {
  readonly name: string;
  /** Prepares the backend (e.g. creates the bucket). Safe to call repeatedly. */
  init(): Promise<void>;
  /** Uploads (or moves) a local file to `key`. */
  put(localPath: string, key: string, size: number, onProgress?: UploadProgress): Promise<void>;
  /** Returns an expiring download URL for `key`. */
  link(key: string, fileName: string, ttlSec: number): Promise<string>;
  delete(key: string): Promise<void>;
}

/** RFC 6266 / RFC 5987 Content-Disposition value that survives non-ASCII file names. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
