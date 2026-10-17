import { join } from 'node:path';
import { Aria2Client } from './aria2.js';
import { buildApp, loggerOptions } from './app.js';
import { loadConfig } from './config.js';
import { createStorage } from './storage/index.js';
import { JobStore } from './store.js';
import { Worker } from './worker.js';

async function retry<T>(label: string, fn: () => Promise<T>, attempts = 30, delayMs = 2000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) {
        throw new Error(`${label} not ready: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new JobStore(join(config.DATA_DIR, 'jobs.sqlite'));
  const aria2 = new Aria2Client(config.ARIA2_RPC_URL, config.ARIA2_RPC_SECRET);
  const storage = createStorage(config);

  // The worker logs through the app logger, which exists once the app is built.
  const worker = new Worker(config, store, aria2, storage, {
    error: (obj, msg) => app.log.error(obj, msg),
  });
  const app = await buildApp({ config, store, aria2, storage, worker }, loggerOptions(config.LOG_LEVEL));

  const version = await retry('aria2', () => aria2.getVersion());
  await retry('storage', () => storage.init());
  app.log.info({ aria2: version.version, storage: storage.name }, 'dependencies ready');

  worker.start();
  await app.listen({ port: config.PORT, host: config.HOST });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    worker.stop();
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
