// One handler per job kind. A handler records its steps as it goes (the live checklist),
// throws JobError with a plain-French message to fail, and is safe to run again: a retry
// skips the steps that are already done where repeating them would be wrong or slow.

import { getAgency, readState, updateAgency, type Agency } from '../agencies.ts';
import { openAlert, resolveAlert } from '../alerts.ts';
import { deriveNames, validateAgencyConfig } from '../provision/plan.ts';
import { scrub, stepCatalog, type State } from '../provision/run.ts';
import type { Platform } from '../platform.ts';
import { appendLog, saveSteps, type Job, type JobKind, type JobStep, type StepResult } from './queue.ts';
import { backupAgency, dbTarget, exportData, instanceApi, JobError, openStored, requireState, runProvision, waitHealthy, type BackupReason, type BackupRow } from './ops.ts';

export type JobCtx = {
  p: Platform;
  job: Job;
  agency: Agency;
  log(line: string): void;
  /** Runs fn as step `id` (marks running, then done / failed). */
  step<T>(id: string, label: string, fn: () => Promise<T>, opts?: { skipIfDone?: boolean; note?: (v: T) => string | undefined }): Promise<T | undefined>;
  setStep(id: string, label: string, result: StepResult, note?: string): Promise<void>;
  /** Merged into jobs.result at the end. */
  result: Record<string, unknown>;
  /** Encrypted one-time output (invite link). */
  secret?: Record<string, unknown>;
  flush(): Promise<void>;
};

type Handler = (c: JobCtx) => Promise<void>;

const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** Planned steps per kind, drawn before the job starts. */
export function plannedSteps(kind: JobKind, params: Record<string, unknown> = {}): JobStep[] {
  const s = (pairs: [string, string][]): JobStep[] => pairs.map(([id, label]) => ({ id, label, result: 'todo' }));
  switch (kind) {
    case 'provision':
      return stepCatalog().map((x) => ({ ...x, result: 'todo' as const }));
    case 'domain':
      return s([['custom-domain', "Domaine de l'agence"]]);
    case 'upgrade':
      return s([
        ['backup', 'Sauvegarde avant mise à jour'],
        ['migrate', 'Schéma mis à jour (migrations)'],
        ['seed', 'Données de référence'],
        ['app', 'Nouvelle version configurée'],
        ['deploy', 'Application redéployée'],
        ['health', 'Instance en ligne'],
      ]);
    case 'backup':
      return s([['dump', 'Sauvegarde de la base'], ['size', 'Taille du stockage']]);
    case 'restore':
      return s([
        ['safety', 'Sauvegarde de sécurité (état actuel)'],
        ['stop', 'Application arrêtée'],
        ['restore', 'Base restaurée'],
        ['start', 'Application redémarrée'],
        ['health', 'Instance en ligne'],
      ]);
    case 'restore_drill':
      return s([['restore', 'Restauration dans une base temporaire'], ['check', 'Contrôle du contenu'], ['cleanup', 'Base temporaire supprimée']]);
    case 'suspend':
      return s([['license', 'Agence suspendue (lecture seule)']]);
    case 'resume':
      return s([['license', 'Agence réactivée']]);
    case 'license':
      return s([['license', 'Offre appliquée']]);
    case 'export':
      return s([['export-start', 'Export lancé sur l\'instance'], ['export-ready', 'Archive prête'], ['export-copy', 'Copie conservée par la Console']]);
    case 'delete':
      return s([
        ['suspend', 'Accès suspendu'],
        ...(params.skipExport ? [] : ([['export-start', 'Export final lancé'], ['export-ready', 'Archive prête'], ['export-copy', 'Archive conservée']] as [string, string][])),
        ['backup', 'Sauvegarde finale de la base'],
        ['app', 'Application supprimée'],
        ['route', 'Route publique retirée'],
        ['database', 'Base de données supprimée'],
        ['storage', 'Stockage supprimé'],
        ['record', 'Fiche archivée'],
      ]);
  }
}

// ---------- provision ----------

const provisionHandler: Handler = async (c) => {
  const tag = String(c.job.params.tag ?? c.agency.imageTag ?? c.p.settings.defaultTag);
  const { report, state } = await runProvision(c.p, c.agency, {
    imageTag: tag,
    log: c.log,
    onStep: async (s) => {
      // A retry reports finished steps as "skipped": keep showing them as done.
      if (s.result === 'skipped' && c.job.steps.find((x) => x.id === s.id)?.result === 'done') return;
      await c.setStep(s.id, s.label, s.result, s.note);
    },
    onInvite: async (invite) => {
      c.secret = { ...invite };
      const emailed = await c.p.infra.notify
        .invite({ to: invite.email, name: invite.name, agencyName: c.agency.name, url: invite.inviteUrl, expiresAt: invite.expiresAt })
        .catch((err) => {
          c.log(`email d'invitation non envoyé : ${err instanceof Error ? err.message : String(err)}`);
          return false;
        });
      c.result.inviteEmailed = emailed;
      c.result.inviteExpiresAt = invite.expiresAt ?? null;
      c.log(emailed ? `invitation envoyée par email à ${invite.email}` : `invitation à transmettre à ${invite.email} (lien visible sur cette page pendant 24 h)`);
    },
  });
  const pending = report.steps.find((s) => s.id === 'custom-domain')?.result === 'pending';
  const fresh = c.agency.status === 'provisioning' || c.agency.status === 'failed';
  await updateAgency(c.p.sql, c.agency.id, {
    imageTag: state.deployedTag ?? c.agency.imageTag,
    domainPending: pending,
    status: report.ok ? (fresh ? 'active' : c.agency.status) : fresh ? 'failed' : c.agency.status,
  });
  if (!report.ok) {
    const failed = report.steps.find((s) => s.result === 'failed');
    throw new JobError(`${failed?.label ?? 'Une étape'} : ${failed?.note ?? 'échec'}`);
  }
};

// ---------- custom domain (wizard choice, "changer de domaine", automatic re-check) ----------

const domainHandler: Handler = async (c) => {
  if ('domain' in c.job.params) {
    const domain = c.job.params.domain ? String(c.job.params.domain).trim().toLowerCase() : undefined;
    const check = validateAgencyConfig({ ...c.agency.config, domain });
    if (!check.ok) throw new JobError(check.errors.join(' ; '));
    const config = { ...c.agency.config, domain };
    await updateAgency(c.p.sql, c.agency.id, { config: c.p.sql.json(config as never) });
    c.agency = { ...c.agency, config };
  }
  if (!c.agency.config.domain) {
    await c.setStep('custom-domain', "Domaine de l'agence", 'done', "pas de domaine propre : l'adresse de la plateforme sert");
    await updateAgency(c.p.sql, c.agency.id, { domainPending: false });
    return;
  }
  const state = requireState(c.p, c.agency);
  const { report } = await runProvision(c.p, c.agency, {
    imageTag: state.imageTag ?? c.agency.imageTag ?? c.p.settings.defaultTag,
    only: ['custom-domain'],
    log: c.log,
    onStep: (s) => c.setStep(s.id, s.label, s.result, s.note),
  });
  const step = report.steps.find((s) => s.id === 'custom-domain');
  await updateAgency(c.p.sql, c.agency.id, { domainPending: step?.result === 'pending' });
  if (!report.ok) throw new JobError(step?.note ?? 'échec du changement de domaine');
  c.result.domainPending = step?.result === 'pending';
};

// ---------- upgrade with automatic rollback ----------

const upgradeHandler: Handler = async (c) => {
  const tag = String(c.job.params.tag ?? '');
  if (!TAG.test(tag)) throw new JobError(`Version invalide : « ${tag} »`);
  const before = requireState(c.p, c.agency);
  const previous = before.deployedTag ?? c.agency.imageTag;
  c.result.from = previous;
  c.result.to = tag;

  await c.step('backup', 'Sauvegarde avant mise à jour', () => backupAgency(c.p, c.agency, 'pre-upgrade'), { skipIfDone: true, note: (b) => `${Math.round(b.size / 1024)} Ko` });

  const { report, state } = await runProvision(c.p, c.agency, {
    imageTag: tag,
    log: c.log,
    onStep: async (s) => {
      if (c.job.steps.some((x) => x.id === s.id)) await c.setStep(s.id, s.label, s.result === 'skipped' ? 'done' : s.result, s.note);
    },
  });
  if (report.ok) {
    await updateAgency(c.p.sql, c.agency.id, { imageTag: state.deployedTag ?? tag });
    return;
  }

  const failed = report.steps.find((s) => s.result === 'failed');
  const deployedNew = state.deployedTag === tag || state.imageTag === tag;
  if (!deployedNew || !previous || previous === tag) {
    // Nothing of the new version runs (migration or image step failed before the deploy).
    throw new JobError(`${failed?.label ?? 'Mise à jour'} : ${failed?.note ?? 'échec'}. L'agence reste en ${previous ?? 'version précédente'}.`);
  }

  // The new version was deployed but does not come up: put the previous image back.
  // Migrations stay applied (they are additive by rule), so the old code runs on the new schema.
  await c.setStep('rollback', 'Retour à la version précédente', 'running');
  const back = await runProvision(c.p, c.agency, { imageTag: previous, only: ['app', 'deploy', 'health'], log: c.log });
  if (back.report.ok) {
    await c.setStep('rollback', 'Retour à la version précédente', 'done', `revenue en ${previous}`);
    await updateAgency(c.p.sql, c.agency.id, { imageTag: previous });
    c.result.rolledBack = true;
    throw new JobError(`La version ${tag} n'a pas démarré (${failed?.note ?? 'échec'}). L'agence est revenue en ${previous} et fonctionne.`);
  }
  const why = back.report.steps.find((s) => s.result === 'failed')?.note ?? 'échec';
  await c.setStep('rollback', 'Retour à la version précédente', 'failed', why);
  await openAlert(c.p.sql, c.p.infra.notify, {
    agencyId: c.agency.id,
    agencyName: c.agency.name,
    kind: 'job',
    key: 'upgrade-rollback',
    message: `Mise à jour vers ${tag} échouée ET retour en ${previous} impossible : l'agence est probablement hors ligne.\n${why}`,
  });
  throw new JobError(`La version ${tag} n'a pas démarré et le retour en ${previous} a aussi échoué (${why}). Intervention nécessaire.`);
};

// ---------- backup ----------

const backupHandler: Handler = async (c) => {
  const reason = (['nightly', 'manual'].includes(String(c.job.params.reason)) ? c.job.params.reason : 'manual') as BackupReason;
  const b = await c.step('dump', 'Sauvegarde de la base', () => backupAgency(c.p, c.agency, reason), { note: (b) => `${Math.round(b.size / 1024)} Ko` });
  c.result.backupId = b?.id;
  await c.step(
    'size',
    'Taille du stockage',
    async () => {
      const bytes = await c.p.infra.storage.bucketSize(deriveNames(c.agency.slug, c.p.settings.platformDomain).bucket);
      await updateAgency(c.p.sql, c.agency.id, { storageBytes: bytes, storageCheckedAt: c.p.infra.now() });
      return bytes;
    },
    { note: (n) => `${(n / 1_048_576).toFixed(1)} Mo` },
  ).catch((err) => c.log(`taille du stockage non mesurée : ${String(err)}`));
  await resolveAlert(c.p.sql, c.p.infra.notify, { agencyId: c.agency.id, agencyName: c.agency.name, key: 'backup', message: 'Sauvegarde de nouveau à jour' });
};

async function pickBackup(c: JobCtx, required: boolean): Promise<BackupRow | null> {
  const id = c.job.params.backupId ? String(c.job.params.backupId) : null;
  const [row] = id
    ? await c.p.sql<BackupRow[]>`SELECT * FROM backups WHERE id = ${id} AND agency_id = ${c.agency.id} AND removed_at IS NULL`
    : await c.p.sql<BackupRow[]>`SELECT * FROM backups WHERE agency_id = ${c.agency.id} AND removed_at IS NULL ORDER BY created_at DESC LIMIT 1`;
  if (!row && required) throw new JobError(id ? 'Sauvegarde introuvable (expirée ?).' : "Aucune sauvegarde pour cette agence.");
  return row ?? null;
}

// ---------- restore (in place: stop, pg_restore --clean in one transaction, start) ----------

const restoreHandler: Handler = async (c) => {
  const state = requireState(c.p, c.agency);
  const backup = (await pickBackup(c, true))!;
  c.result.backupId = backup.id;
  const appId = state.dokployAppId;
  if (!appId) throw new JobError("Application Dokploy inconnue pour cette agence.");

  await c.step('safety', 'Sauvegarde de sécurité (état actuel)', () => backupAgency(c.p, c.agency, 'pre-restore'), { skipIfDone: true });
  await c.step('stop', 'Application arrêtée', () => c.p.infra.dokploy.stop(appId));
  try {
    await c.step('restore', 'Base restaurée', async () => {
      // --single-transaction: a failed restore leaves the database exactly as it was.
      await c.p.infra.dumper.restore(dbTarget(c.p, c.agency, state), await openStored(c.p, backup), { clean: true });
    }, { note: () => `sauvegarde du ${backup.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` });
  } finally {
    await c.step('start', 'Application redémarrée', () => c.p.infra.dokploy.start(appId));
  }
  await c.step('health', 'Instance en ligne', () => waitHealthy(c.p, c.agency), { note: (h) => (h.schemaVersion ? `schéma ${h.schemaVersion}` : undefined) });
};

// ---------- monthly restore drill (into a scratch database, then dropped) ----------

const drillHandler: Handler = async (c) => {
  const state = requireState(c.p, c.agency);
  const backup = (await pickBackup(c, true))!;
  c.result.backupId = backup.id;
  const names = deriveNames(c.agency.slug, c.p.settings.platformDomain);
  const scratch = `${names.dbName}_drill`.slice(0, 63);
  try {
    await c.step('restore', 'Restauration dans une base temporaire', async () => {
      await c.p.infra.pg.dropDatabase(scratch);
      await c.p.infra.pg.createDatabase(scratch, names.dbRole);
      await c.p.infra.dumper.restore(dbTarget(c.p, c.agency, state, scratch), await openStored(c.p, backup), { clean: false });
    });
    const note = await c.step('check', 'Contrôle du contenu', async () => {
      const migrations = Number(await c.p.infra.pg.scalar(scratch, 'SELECT count(*) FROM "_prisma_migrations"'));
      const users = Number(await c.p.infra.pg.scalar(scratch, 'SELECT count(*) FROM "User"'));
      if (!(migrations > 0)) throw new JobError('La sauvegarde ne contient pas de schéma (aucune migration).');
      return `${migrations} migrations, ${users} utilisateurs`;
    }, { note: (n) => n });
    await c.p.sql`UPDATE backups SET verified_at = now(), verify_note = ${note ?? null} WHERE id = ${backup.id}`;
    await resolveAlert(c.p.sql, c.p.infra.notify, { agencyId: c.agency.id, agencyName: c.agency.name, key: 'drill', message: 'Test de restauration réussi' });
  } catch (err) {
    const msg = scrub(err instanceof Error ? err.message : String(err), state.secrets);
    await c.p.sql`UPDATE backups SET verify_note = ${`échec : ${msg}`.slice(0, 500)} WHERE id = ${backup.id}`;
    await openAlert(c.p.sql, c.p.infra.notify, { agencyId: c.agency.id, agencyName: c.agency.name, kind: 'drill', key: 'drill', message: `Le test de restauration mensuel a échoué : ${msg}` });
    throw err;
  } finally {
    await c.step('cleanup', 'Base temporaire supprimée', () => c.p.infra.pg.dropDatabase(scratch));
  }
};

// ---------- license: suspend, resume, change pack ----------

async function putLicense(c: JobCtx, state: State, body: Record<string, unknown>) {
  const res = await instanceApi(c.p, state)('PUT', '/api/instance/license', JSON.stringify(body), { 'Content-Type': 'application/json' });
  if (res.status !== 200) throw new JobError(`Licence refusée par l'instance : HTTP ${res.status} ${JSON.stringify(res.json)?.slice(0, 300)}`);
  return res.json;
}

const suspendHandler: Handler = async (c) => {
  const state = requireState(c.p, c.agency);
  const reason = c.job.params.reason ? String(c.job.params.reason).slice(0, 300) : 'Suspendue par la Console';
  await c.step('license', 'Agence suspendue (lecture seule)', () => putLicense(c, state, { status: 'SUSPENDED', suspendedReason: reason }));
  await updateAgency(c.p.sql, c.agency.id, { status: 'suspended' });
};

const resumeHandler: Handler = async (c) => {
  const state = requireState(c.p, c.agency);
  await c.step('license', 'Agence réactivée', () => putLicense(c, state, { status: 'ACTIVE', suspendedReason: null }));
  await updateAgency(c.p.sql, c.agency.id, { status: 'active' });
};

const licenseHandler: Handler = async (c) => {
  const state = requireState(c.p, c.agency);
  const body: Record<string, unknown> = {};
  for (const k of ['plan', 'seatLimit', 'features', 'aiMonthlyQuota'] as const) if (k in c.job.params) body[k] = c.job.params[k];
  const json = await c.step('license', 'Offre appliquée', () => putLicense(c, state, body));
  const config = { ...c.agency.config, license: { ...c.agency.config.license, ...body }, extra: { ...c.agency.config.extra, pack: c.job.params.pack ? String(c.job.params.pack) : c.agency.config.extra?.pack } };
  await updateAgency(c.p.sql, c.agency.id, { config: c.p.sql.json(config as never) });
  c.result.seats = (json as { seats?: unknown } | undefined)?.seats ?? null;
};

// ---------- export ----------

async function exportSteps(c: JobCtx) {
  const done = c.job.steps.find((s) => s.id === 'export-copy')?.result === 'done';
  if (done) return;
  await c.setStep('export-start', "Export lancé sur l'instance", 'running');
  const out = await exportData(c.p, c.agency, c.job.id, async (id, note) => {
    await c.setStep(id, '', 'done', note);
    if (id === 'export-start') await c.setStep('export-ready', 'Archive prête', 'running');
    if (id === 'export-ready') await c.setStep('export-copy', 'Copie conservée par la Console', 'running');
  });
  await c.setStep('export-copy', '', 'done', `${(out.bytes / 1_048_576).toFixed(1)} Mo`);
  c.result.exportId = out.exportRowId;
}

const exportHandler: Handler = async (c) => {
  await exportSteps(c);
};

// ---------- delete (export, final backup, then every resource) ----------

const deleteHandler: Handler = async (c) => {
  if (c.job.params.confirm !== c.agency.slug) throw new JobError('Confirmation manquante : le nom court de l’agence doit être retapé.');
  const state = readState(c.p.sealer, c.agency);
  const names = deriveNames(c.agency.slug, c.p.settings.platformDomain);
  await updateAgency(c.p.sql, c.agency.id, { status: 'deleting' });
  const once = { skipIfDone: true };

  if (state) {
    await c.step('suspend', 'Accès suspendu', async () => {
      try {
        await putLicense(c, state, { status: 'SUSPENDED', suspendedReason: 'Suppression en cours' });
      } catch (err) {
        if (!c.job.params.skipExport) throw err;
        c.log(`instance injoignable, suspension ignorée : ${String(err)}`);
      }
    }, once);
    if (!c.job.params.skipExport) await exportSteps(c);
    await c.step('backup', 'Sauvegarde finale de la base', async () => {
      try {
        return await backupAgency(c.p, c.agency, 'final');
      } catch (err) {
        if (!c.job.params.skipExport) throw err;
        c.log(`sauvegarde finale impossible, ignorée (suppression forcée) : ${String(err)}`);
        return null;
      }
    }, once);
    if (state.dokployAppId) {
      const appId = state.dokployAppId;
      await c.step('app', 'Application supprimée', () => c.p.infra.dokploy.deleteApplication(appId).catch((err: { status?: number }) => {
        if (err?.status === 404) return null; // already gone
        throw err;
      }), once);
    } else await c.setStep('app', 'Application supprimée', 'skipped', "aucune application n'avait été créée");
  } else {
    for (const id of ['suspend', 'backup', 'app']) await c.setStep(id, '', 'skipped', 'jamais provisionnée');
  }

  await c.step('route', 'Route publique retirée', async () => {
    if (c.p.infra.proxy) await c.p.infra.proxy.removeRoute(c.agency.slug);
    else c.log(`aucun proxy configuré : supprimez agency-${c.agency.slug}.yml à la main s'il existe`);
  }, once);
  await c.step('database', 'Base de données supprimée', async () => {
    await c.p.infra.pg.dropDatabase(names.dbName);
    await c.p.infra.pg.dropDatabase(`${names.dbName}_drill`.slice(0, 63));
    await c.p.infra.pg.dropRole(names.dbRole);
  }, once);
  await c.step('storage', 'Stockage supprimé', async () => {
    await c.p.infra.storage.removeBucket(names.bucket);
    if (state?.minio && c.p.infra.storage.removeKey) await c.p.infra.storage.removeKey(state.minio.accessKeyId);
  }, once);
  await c.step('record', 'Fiche archivée', async () => {
    await c.p.sql`DELETE FROM agency_cron WHERE agency_id = ${c.agency.id}`;
    await c.p.sql`DELETE FROM agency_logos WHERE agency_id = ${c.agency.id}`;
    await c.p.sql`UPDATE alerts SET resolved_at = now() WHERE agency_id = ${c.agency.id} AND resolved_at IS NULL`;
    // Secrets go with the agency; backups and the export stay until they expire.
    await updateAgency(c.p.sql, c.agency.id, { status: 'deleted', deletedAt: c.p.infra.now(), stateEnc: null, healthOk: null, domainPending: false });
  });
};

export const HANDLERS: Record<JobKind, Handler> = {
  provision: provisionHandler,
  domain: domainHandler,
  upgrade: upgradeHandler,
  backup: backupHandler,
  restore: restoreHandler,
  restore_drill: drillHandler,
  suspend: suspendHandler,
  resume: resumeHandler,
  license: licenseHandler,
  export: exportHandler,
  delete: deleteHandler,
};

/** Runs one claimed job to the end. Never throws: the outcome is written to the job row. */
export async function runJob(p: Platform, job: Job): Promise<'succeeded' | 'failed'> {
  const agency = await getAgency(p.sql, job.agencyId);
  if (!agency) {
    await p.sql`UPDATE jobs SET status = 'failed', finished_at = now(), error = 'agence introuvable' WHERE id = ${job.id}`;
    return 'failed';
  }
  if (!job.steps.length) job.steps = plannedSteps(job.kind, job.params);
  // A retry starts the unfinished steps again.
  job.steps = job.steps.map((s) => (s.result === 'running' || s.result === 'failed' ? { ...s, result: 'todo', note: undefined } : s));
  await saveSteps(p.sql, job.id, job.steps);

  let chain: Promise<unknown> = Promise.resolve();
  const secrets = readState(p.sealer, agency)?.secrets;
  const clean = (t: string) => (secrets ? scrub(t, secrets) : t);
  const log = (line: string) => {
    chain = chain.then(() => appendLog(p.sql, job.id, clean(line))).catch(() => undefined);
  };
  const setStep = async (id: string, label: string, result: StepResult, note?: string) => {
    const at = p.infra.now().toISOString();
    const i = job.steps.findIndex((s) => s.id === id);
    const cleanNote = note === undefined ? undefined : clean(note).slice(0, 2000);
    if (i >= 0) job.steps[i] = { ...job.steps[i]!, label: label || job.steps[i]!.label, result, note: cleanNote ?? (result === 'running' ? undefined : job.steps[i]!.note), at };
    else job.steps.push({ id, label: label || id, result, note: cleanNote, at });
    await saveSteps(p.sql, job.id, job.steps);
  };
  const ctx: JobCtx = {
    p,
    job,
    agency,
    log,
    setStep,
    result: {},
    async step(id, label, fn, opts = {}) {
      if (opts.skipIfDone && job.steps.find((s) => s.id === id)?.result === 'done') return undefined;
      await setStep(id, label, 'running');
      try {
        const v = await fn();
        await setStep(id, label, 'done', opts.note?.(v));
        return v;
      } catch (err) {
        await setStep(id, label, 'failed', err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    flush: () => chain.then(() => undefined),
  };

  let status: 'succeeded' | 'failed' = 'succeeded';
  let error: string | undefined;
  try {
    await HANDLERS[job.kind](ctx);
  } catch (err) {
    status = 'failed';
    error = clean(err instanceof JobError ? err.message : `Erreur inattendue : ${err instanceof Error ? err.message : String(err)}`).slice(0, 2000);
    log(`ÉCHEC : ${error}`);
  }
  await ctx.flush();
  if (ctx.secret) await p.sql`UPDATE jobs SET secret_enc = ${p.sealer.seal(JSON.stringify(ctx.secret))} WHERE id = ${job.id}`;
  await p.sql`
    UPDATE jobs SET status = ${status}, finished_at = now(), error = ${error ?? null},
      result = coalesce(result, '{}'::jsonb) || ${p.sql.json(ctx.result as never)}
    WHERE id = ${job.id}`;

  // Jobs nobody is watching (nightly, drills) and the ones that leave an agency half-changed alert on failure.
  if (status === 'failed' && ['backup', 'upgrade', 'delete', 'restore', 'provision'].includes(job.kind) && !job.createdBy) {
    await openAlert(p.sql, p.infra.notify, { agencyId: agency.id, agencyName: agency.name, kind: 'job', key: `job:${job.kind}`, message: `Tâche automatique « ${job.kind} » en échec : ${error}` });
  }
  return status;
}
