// Backups and exports are encrypted before they leave the Console (to MinIO and to the off-site
// bucket). The format describes itself, so a copy can be decrypted with CONSOLE_ENCRYPTION_KEY alone,
// even when the Console's database is gone (`npm run backup:decrypt`):
//
//   "CPBK" | version 1 (1 byte) | IV (12 bytes) | AES-256-GCM ciphertext | auth tag (16 bytes)
//
// The key is derived from CONSOLE_ENCRYPTION_KEY (HKDF-SHA256), so the team vault holds one key.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, type DecipherGCM } from 'node:crypto';
import { Transform } from 'node:stream';

const MAGIC = Buffer.from('CPBK');
const VERSION = 1;
const HEADER = MAGIC.length + 1 + 12;
const TAG = 16;

export function deriveBackupKey(consoleKeyHex: string): Buffer {
  const ikm = Buffer.from(consoleKeyHex, 'hex');
  if (ikm.length !== 32) throw new Error('encryption key must be 32 bytes');
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'console-backups/v1', 32));
}

/** Plain bytes in, the encrypted format out. */
export function encryptStream(key: Buffer): Transform {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let started = false;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      if (!started) {
        started = true;
        this.push(Buffer.concat([MAGIC, Buffer.from([VERSION]), iv]));
      }
      done(null, cipher.update(chunk));
    },
    flush(done) {
      if (!started) this.push(Buffer.concat([MAGIC, Buffer.from([VERSION]), iv]));
      this.push(cipher.final());
      done(null, cipher.getAuthTag());
    },
  });
}

/**
 * The encrypted format in, plain bytes out. The last 16 bytes (the tag) are held back until the end;
 * a wrong key or a modified file fails the stream at the end ("unable to authenticate data").
 */
export function decryptStream(key: Buffer): Transform {
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let decipher: DecipherGCM | null = null;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      try {
        let data = chunk;
        if (!decipher) {
          head = Buffer.concat([head, data]);
          if (head.length < HEADER) return done();
          if (!head.subarray(0, 4).equals(MAGIC)) throw new Error('pas une sauvegarde chiffrée par la Console (en-tête inconnu)');
          if (head[4] !== VERSION) throw new Error(`version de chiffrement inconnue : ${head[4]}`);
          decipher = createDecipheriv('aes-256-gcm', key, head.subarray(5, HEADER));
          data = head.subarray(HEADER);
        }
        const all = Buffer.concat([tail, data]);
        tail = all.subarray(Math.max(0, all.length - TAG));
        const body = all.subarray(0, all.length - tail.length);
        done(null, body.length ? decipher.update(body) : undefined);
      } catch (err) {
        done(err as Error);
      }
    },
    flush(done) {
      try {
        if (!decipher || tail.length !== TAG) throw new Error('sauvegarde chiffrée tronquée');
        decipher.setAuthTag(tail);
        done(null, decipher.final());
      } catch (err) {
        done(err as Error);
      }
    },
  });
}
