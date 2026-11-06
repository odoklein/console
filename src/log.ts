// One JSON object per line on stdout/stderr: Dokploy and any log shipper read it as is.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

type Fields = Record<string, unknown>;

function write(level: LogLevel, msg: string, fields?: Fields): void {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }) + '\n';
  if (LEVELS[level] >= LEVELS.warn) process.stderr.write(line);
  else process.stdout.write(line);
}

export const log = {
  debug: (msg: string, fields?: Fields) => write('debug', msg, fields),
  info: (msg: string, fields?: Fields) => write('info', msg, fields),
  warn: (msg: string, fields?: Fields) => write('warn', msg, fields),
  error: (msg: string, fields?: Fields) => write('error', msg, fields),
};

/** Errors serialize to {} with JSON.stringify; keep the parts worth reading. */
export function errorFields(err: unknown): Fields {
  if (!(err instanceof Error)) return { error: String(err) };
  return { error: err.message, code: (err as { code?: unknown }).code, stack: err.stack };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
