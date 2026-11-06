import postgres from 'postgres';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

export function createDb(url: string, max = 10): Sql {
  return postgres(url, {
    max,
    onnotice: () => {}, // "relation already exists, skipping" and friends
    transform: { column: { from: postgres.toCamel }, undefined: null },
  });
}

/** Postgres error classes caused by the data itself (22 data exception, 23 constraint violation). */
export function isDataError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code.startsWith('22') || code.startsWith('23'));
}
