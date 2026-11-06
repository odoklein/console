import { createDb } from '../db.ts';
import { migrate } from '../migrate.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquant');
  process.exit(2);
}
const sql = createDb(url, 1);
try {
  const applied = await migrate(sql);
  console.log(applied.length ? `Appliquées : ${applied.join(', ')}` : 'Rien à appliquer.');
} finally {
  await sql.end({ timeout: 2 });
}
