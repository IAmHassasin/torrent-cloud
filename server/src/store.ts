import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Job, JobStatus } from './jobs.js';

interface Row {
  id: string;
  data: string;
}

/** Persists jobs as JSON documents in SQLite. One worker process owns the database. */
export class JobStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
    `);
  }

  insert(job: Job): void {
    this.db
      .prepare('INSERT INTO jobs (id, status, created_at, data) VALUES (?, ?, ?, ?)')
      .run(job.id, job.status, job.createdAt, JSON.stringify(job));
  }

  get(id: string): Job | undefined {
    const row = this.db.prepare('SELECT id, data FROM jobs WHERE id = ?').get(id) as Row | undefined;
    return row ? (JSON.parse(row.data) as Job) : undefined;
  }

  list(limit = 100): Job[] {
    const rows = this.db
      .prepare('SELECT id, data FROM jobs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as unknown as Row[];
    return rows.map((row) => JSON.parse(row.data) as Job);
  }

  listByStatus(statuses: readonly JobStatus[]): Job[] {
    const placeholders = statuses.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT id, data FROM jobs WHERE status IN (${placeholders}) ORDER BY created_at`)
      .all(...statuses) as unknown as Row[];
    return rows.map((row) => JSON.parse(row.data) as Job);
  }

  update(id: string, patch: Partial<Job>): Job {
    const current = this.get(id);
    if (!current) throw new Error(`Job ${id} not found`);
    const next: Job = { ...current, ...patch, id, updatedAt: new Date().toISOString() };
    this.db
      .prepare('UPDATE jobs SET status = ?, data = ? WHERE id = ?')
      .run(next.status, JSON.stringify(next), id);
    return next;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }
}
