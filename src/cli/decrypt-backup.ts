// Decrypts a backup or export downloaded from MinIO or the off-site bucket, with nothing but the
// key from the team vault (the Console and its database may be gone):
//   CONSOLE_ENCRYPTION_KEY=… npm run backup:decrypt -- 20261029T020000Z-nightly.dump.enc out.dump
// Then: pg_restore --no-owner --no-acl -d <database> out.dump (or unzip for an export).

import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { decryptStream, deriveBackupKey } from '../backup-crypto.ts';

const [input, output] = process.argv.slice(2);
const key = process.env.CONSOLE_ENCRYPTION_KEY;
if (!input || !output) {
  console.error('Usage: npm run backup:decrypt -- <fichier.enc> <fichier de sortie>');
  process.exit(2);
}
if (!key || !/^[0-9a-f]{64}$/i.test(key)) {
  console.error('CONSOLE_ENCRYPTION_KEY manquante ou invalide (64 caractères hexadécimaux, coffre de l’équipe).');
  process.exit(2);
}
try {
  await pipeline(createReadStream(input), decryptStream(deriveBackupKey(key)), createWriteStream(output));
  console.log(`Déchiffré : ${output}`);
} catch (err) {
  console.error(`Échec : ${err instanceof Error ? err.message : String(err)} (mauvaise clé ou fichier modifié ?)`);
  process.exit(1);
}
