export type JobStatus = 'queued' | 'downloading' | 'uploading' | 'done' | 'failed' | 'cancelled';

export interface JobFile {
  /** Path relative to the job directory, always using forward slashes. */
  path: string;
  size: number;
}

export interface StoredObject {
  name: string;
  key: string;
  size: number;
}

export interface Job {
  id: string;
  status: JobStatus;
  source: 'magnet' | 'torrent';
  name: string | null;
  gid: string | null;
  infoHash: string | null;
  zip: boolean;
  totalBytes: number;
  completedBytes: number;
  downloadSpeed: number;
  connections: number;
  numSeeders: number;
  uploadedBytes: number;
  files: JobFile[];
  objects: StoredObject[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export const ACTIVE_STATUSES: readonly JobStatus[] = ['queued', 'downloading', 'uploading'];

export function isTerminal(status: JobStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}
