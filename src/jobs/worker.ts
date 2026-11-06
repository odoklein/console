import { errorFields, log } from '../log.ts';
import type { Platform } from '../platform.ts';
import { rolloutAfterJob } from '../rollouts.ts';
import { runJob } from './handlers.ts';
import { claim } from './queue.ts';

/** Claims and runs one job. Returns false when the queue had nothing runnable. */
export async function runOnce(p: Platform): Promise<boolean> {
  const job = await claim(p.sql);
  if (!job) return false;
  log.info('job.start', { id: job.id, kind: job.kind, agency: job.agencyId, attempt: job.attempts });
  const status = await runJob(p, job);
  log.info('job.end', { id: job.id, kind: job.kind, status });
  // A fleet rollout starts its next agency (or stops) here.
  await rolloutAfterJob(p, job, status).catch((err) => log.error('rollout.advance_failed', { job: job.id, ...errorFields(err) }));
  return true;
}

export function startWorker(p: Platform, opts: { concurrency: number; idleMs?: number }) {
  let stopping = false;
  let wake: (() => void) | null = null;
  const idleMs = opts.idleMs ?? 2_000;

  async function loop(n: number) {
    while (!stopping) {
      let worked = false;
      try {
        worked = await runOnce(p);
      } catch (err) {
        log.error('worker.error', { slot: n, ...errorFields(err) });
      }
      if (!worked && !stopping) await new Promise<void>((r) => ((wake = r), setTimeout(r, idleMs)));
    }
  }
  const loops = Array.from({ length: opts.concurrency }, (_, i) => loop(i));
  return {
    kick() {
      wake?.();
    },
    async stop() {
      stopping = true;
      wake?.();
      await Promise.all(loops);
    },
  };
}
