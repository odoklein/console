// Everything the Console does to servers goes through this interface: src/infra/real.ts in
// production, fakes in the tests. The provisioning part is the vendored Deps of run.ts.

import type { Readable } from 'node:stream';
import type { Deps } from '../provision/run.ts';

export type Infra = {
  pg: Deps['pg'] & {
    /** DROP DATABASE … WITH (FORCE), no error when absent. */
    dropDatabase(db: string): Promise<void>;
    dropRole(role: string): Promise<void>;
    /** One-value query on a database of the cluster (restore drill checks). */
    scalar(db: string, query: string): Promise<string | null>;
  };
  storage: Deps['storage'] & {
    /** Deletes every object then the bucket. */
    removeBucket(bucket: string): Promise<void>;
    bucketSize(bucket: string): Promise<number>;
    /** Removes the bucket-scoped key (mc admin user remove). */
    removeKey?(accessKeyId: string): Promise<void>;
  };
  /** Platform bucket for dumps and final exports. */
  backups: {
    put(key: string, body: Readable | Uint8Array, contentType?: string): Promise<number>;
    get(key: string): Promise<Readable>;
    remove(key: string): Promise<void>;
    /** Short-lived download link. */
    url(key: string, filename: string): Promise<string>;
  };
  /** Second provider (Backblaze B2) holding a copy of every encrypted backup and export. Absent = not configured. */
  offsite?: {
    /** "b2 · s3.eu-central-003.backblazeb2.com/bucket": where the copies go, for the pages. */
    label: string;
    put(key: string, body: Readable): Promise<number>;
    remove(key: string): Promise<void>;
  };
  /** pg_dump / pg_restore with the agency role's own credentials. */
  dumper: {
    dump(target: DbTarget): { stream: Readable; done: Promise<void> };
    /** clean = drop the existing objects first (in-place restore). */
    restore(target: DbTarget, input: Readable, opts: { clean: boolean }): Promise<void>;
  };
  runDbJob: Deps['runDbJob'];
  dokploy: Deps['dokploy'] & {
    stop(applicationId: string): Promise<unknown>;
    start(applicationId: string): Promise<unknown>;
    deleteApplication(applicationId: string): Promise<unknown>;
  };
  instance: Deps['instance'];
  dns: Deps['dns'];
  proxy?: NonNullable<Deps['proxy']> & { removeRoute(slug: string): Promise<void> };
  /** Plain HTTP GET (export download before the copy to the platform bucket). */
  download(url: string): Promise<Readable>;
  notify: Notifier;
  sleep(ms: number): Promise<void>;
  now(): Date;
};

export type DbTarget = { host: string; port: number; database: string; user: string; password: string; params?: string };

export type Notifier = {
  /** Operator alert: email to ALERT_EMAIL_TO and/or Slack. Resolves false when no channel is configured. */
  alert(subject: string, text: string): Promise<boolean>;
  /** Invite email to an agency's first manager. Resolves false when SMTP is not configured. */
  invite(input: { to: string; name: string; agencyName: string; url: string; expiresAt?: string }): Promise<boolean>;
};
