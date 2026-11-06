// Operator-facing wording: offline reasons, journal labels, failed-job banner.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { healthReason } from '../src/health-reason.ts';
import { auditLabel } from '../src/http/views/format.ts';
import { jobErrorSummary } from '../src/http/views/misc.ts';

test('offline reasons are explained, unknown errors are kept', () => {
  assert.match(healthReason('fetch failed'), /ne répond pas/);
  assert.match(healthReason('getaddrinfo ENOTFOUND demo.example'), /DNS/);
  assert.match(healthReason('The operation was aborted due to timeout'), /trop de temps/);
  assert.match(healthReason('HTTP 401 {"error":"invalid_signature"}'), /secret d’instance/);
  assert.match(healthReason('unable to verify the first certificate'), /certificat/);
  assert.match(healthReason('HTTP 502'), /erreur du serveur/);
  assert.equal(healthReason(null), 'ne répond pas');
  assert.equal(healthReason('something new'), 'something new');
});

test('journal labels: known codes in French, job kinds, unknown codes as is', () => {
  assert.equal(auditLabel('login'), 'Connexion');
  assert.equal(auditLabel('operator.setup'), 'Accès activé');
  assert.equal(auditLabel('job.backup'), 'Sauvegarde lancée');
  assert.equal(auditLabel('job.upgrade'), 'Mise à jour lancée');
  assert.equal(auditLabel('brand.new.thing'), 'brand.new.thing');
});

test('failed-job banner points at the failed step instead of repeating its error', () => {
  const steps = [
    { id: 'backup', label: 'Sauvegarde de la base', result: 'failed' as const, note: 'spawn pg_dump ENOENT' },
    { id: 'size', label: 'Taille du stockage', result: 'todo' as const },
  ];
  assert.match(jobErrorSummary({ error: 'spawn pg_dump ENOENT', steps }), /Arrêt à l’étape « Sauvegarde de la base »/);
  assert.equal(jobErrorSummary({ error: 'boom', steps: [] }), 'boom');
  assert.equal(jobErrorSummary({ error: null, steps }), '');
});
