import { readFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { deriveBackupKey } from './backup-crypto.ts';
import { loadConfig } from './config.ts';
import { createSealer } from './crypto.ts';
import { createDb } from './db.ts';
import { createApp } from './http/app.ts';
import { configureMcAlias, realInfra } from './infra/real.ts';
import { failInterrupted } from './jobs/queue.ts';
import { startWorker } from './jobs/worker.ts';
import { errorFields, log, setLogLevel } from './log.ts';
import { migrate } from './migrate.ts';
import { settingsFromConfig, type Platform } from './platform.ts';
import { parseEnvFile } from './provision/plan.ts';
import { startScheduler } from './scheduler.ts';

const config = (() => {
  try {
    return loadConfig();
  } catch (err) {
    log.error('config.invalid', errorFields(err));
    process.exit(1);
  }
})();
setLogLevel(config.LOG_LEVEL);

const sql = createDb(config.DATABASE_URL, config.DB_POOL_MAX);
if (config.MIGRATE_ON_BOOT) await migrate(sql);

const shared = config.PROVISION_SHARED_ENV ? parseEnvFile(await readFile(config.PROVISION_SHARED_ENV, 'utf8')) : {};
const p: Platform = {
  sql,
  infra: realInfra(config),
  sealer: createSealer(config.CONSOLE_ENCRYPTION_KEY),
  settings: settingsFromConfig(config, shared),
  backupKey: deriveBackupKey(config.CONSOLE_ENCRYPTION_KEY),
};

let worker: ReturnType<typeof startWorker> | null = null;
let scheduler: ReturnType<typeof startScheduler> | null = null;
if (config.ROLE === 'all') {
  const interrupted = await failInterrupted(sql);
  if (interrupted) log.warn('jobs.interrupted', { count: interrupted });
  await configureMcAlias(config);
  worker = startWorker(p, { concurrency: config.WORKER_CONCURRENCY });
  scheduler = startScheduler(p);
}

const server = serve(
  { fetch: createApp({ p, secureCookies: config.CONSOLE_URL.startsWith('https://'), onJobQueued: () => worker?.kick() }).fetch, port: config.PORT },
  (info) => log.info('http.listening', { port: info.port }),
);
log.info('boot', { role: config.ROLE, platform: config.PROVISION_PLATFORM_DOMAIN, defaultTag: config.PROVISION_DEFAULT_TAG, sharedKeys: Object.keys(shared).length });

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info('shutdown', { signal });
  scheduler?.stop();
  server.close();
  // A running job finishes its current step only if it is quick; anything left "running" is failed at next boot.
  await Promise.race([worker?.stop(), new Promise((r) => setTimeout(r, 20_000))]);
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
