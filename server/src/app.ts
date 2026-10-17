import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import { Aria2Error, type Aria2Client } from './aria2.js';
import type { Config } from './config.js';
import type { Job } from './jobs.js';
import { checkTorrentBytes, parseMagnet } from './sources.js';
import { LocalStorage, type StorageProvider } from './storage/index.js';
import type { JobStore } from './store.js';
import type { Worker } from './worker.js';

export interface AppDeps {
  config: Config;
  store: JobStore;
  aria2: Aria2Client;
  storage: StorageProvider;
  worker: Worker;
}

const CreateJobBody = z
  .object({
    magnet: z.string().max(8192).optional(),
    torrentBase64: z.string().max(16 * 1024 * 1024).optional(),
    zip: z.boolean().default(false),
  })
  .strict()
  .refine((b) => Boolean(b.magnet) !== Boolean(b.torrentBase64), {
    message: 'Provide exactly one of "magnet" or "torrentBase64"',
  });

const JobId = z.string().regex(/^[a-f0-9]{12}$/);

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** Hides link tokens from request logs, including percent-encoded spellings of "/files/". */
export function redactUrl(url: string): string {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // Malformed encoding: the router rejects it too; fall through with the raw value.
  }
  return decoded.startsWith('/files/') ? '/files/[redacted]' : url;
}

/** Logger options: request logs contain method, redacted URL and remote address only (no headers). */
export function loggerOptions(level: string): FastifyServerOptions['logger'] {
  return {
    level,
    serializers: {
      req: (req: { method: string; url: string; ip?: string }) => ({
        method: req.method,
        url: redactUrl(req.url),
        remoteAddress: req.ip,
      }),
    },
  };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export async function buildApp(deps: AppDeps, logger: FastifyServerOptions['logger'] = false): Promise<FastifyInstance> {
  const { config, store, aria2, storage, worker } = deps;
  const app = Fastify({
    logger,
    bodyLimit: 24 * 1024 * 1024,
    // Signed local-storage link tokens are longer than the default 100 chars.
    maxParamLength: 2048,
  });
  await app.register(fastifyStatic, { root: publicDir, prefix: '/', index: ['index.html'] });

  const expectedToken = digest(config.TC_API_TOKEN);
  app.addHook('onRequest', async (req, reply) => {
    // Decide on the matched route pattern, not the raw URL: the router percent-decodes paths,
    // so "/%761/jobs" reaches the "/v1/jobs" handler while not starting with "/v1/".
    const route = req.routeOptions.url ?? '';
    if (!route.startsWith('/v1/') && !req.url.startsWith('/v1/')) return;
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !timingSafeEqual(digest(token), expectedToken)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  const view = async (job: Job, withLinks: boolean) => {
    const links = withLinks && job.status === 'done'
      ? await Promise.all(
          job.objects.map(async (o) => ({
            name: o.name,
            size: o.size,
            url: await storage.link(o.key, o.name, config.LINK_TTL_SEC),
            expiresAt: new Date(Date.now() + config.LINK_TTL_SEC * 1000).toISOString(),
          })),
        )
      : [];
    return {
      id: job.id,
      status: job.status,
      source: job.source,
      name: job.name,
      infoHash: job.infoHash,
      zip: job.zip,
      progress: {
        totalBytes: job.totalBytes,
        completedBytes: job.completedBytes,
        percent: job.totalBytes > 0 ? Math.floor((job.completedBytes / job.totalBytes) * 1000) / 10 : 0,
        downloadSpeed: job.downloadSpeed,
        connections: job.connections,
        numSeeders: job.numSeeders,
        uploadedBytes: job.uploadedBytes,
      },
      files: job.files,
      links,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
    };
  };

  app.get('/healthz', async () => ({ ok: true }));

  app.post('/v1/jobs', async (req, reply) => {
    const parsed = CreateJobBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
    const body = parsed.data;

    const id = randomBytes(6).toString('hex');
    const options = { dir: worker.jobDir(id) };
    let gid: string;
    let name: string | null = null;
    let infoHash: string | null = null;
    try {
      if (body.magnet) {
        ({ name, infoHash } = parseMagnet(body.magnet));
        gid = await aria2.addUri([body.magnet.trim()], options);
      } else {
        const bytes = Buffer.from(body.torrentBase64!, 'base64');
        checkTorrentBytes(bytes, config.MAX_TORRENT_BYTES);
        gid = await aria2.addTorrent(bytes.toString('base64'), options);
      }
    } catch (err) {
      if (err instanceof Aria2Error) {
        const duplicate = /already registered/i.test(err.message);
        return reply.code(duplicate ? 409 : 400).send({ error: err.message });
      }
      if (err instanceof Error && !(err instanceof TypeError)) return reply.code(400).send({ error: err.message });
      throw err;
    }

    const now = new Date().toISOString();
    const job: Job = {
      id,
      status: 'queued',
      source: body.magnet ? 'magnet' : 'torrent',
      name,
      gid,
      infoHash,
      zip: body.zip,
      totalBytes: 0,
      completedBytes: 0,
      downloadSpeed: 0,
      connections: 0,
      numSeeders: 0,
      uploadedBytes: 0,
      files: [],
      objects: [],
      error: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    store.insert(job);
    return reply.code(201).send(await view(job, false));
  });

  app.get('/v1/jobs', async () => {
    const jobs = await Promise.all(store.list().map((job) => view(job, false)));
    return { jobs };
  });

  app.get<{ Params: { id: string } }>('/v1/jobs/:id', async (req, reply) => {
    const id = JobId.safeParse(req.params.id);
    const job = id.success ? store.get(id.data) : undefined;
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    return view(job, true);
  });

  app.delete<{ Params: { id: string } }>('/v1/jobs/:id', async (req, reply) => {
    const id = JobId.safeParse(req.params.id);
    if (!id.success || !(await worker.remove(id.data))) return reply.code(404).send({ error: 'Job not found' });
    return reply.code(204).send();
  });

  if (storage instanceof LocalStorage) {
    app.get<{ Params: { token: string } }>('/files/:token', async (req, reply) => {
      const file = storage.verify(req.params.token);
      if (!file) return reply.code(404).send({ error: 'Link is invalid or expired' });
      reply.header(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      );
      return reply.sendFile(basename(file.path), dirname(file.path));
    });
  }

  return app;
}
