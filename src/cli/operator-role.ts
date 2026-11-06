// Changes an operator's role from the command line (the way back when nobody can open the Team page):
//   npm run operator:role -- prenom@exemple.fr owner|operator|support|viewer

import { createDb } from '../db.ts';
import { migrate } from '../migrate.ts';
import { isRole, ROLE_LABELS, ROLES } from '../roles.ts';

const [email, role] = process.argv.slice(2);
if (!email || !isRole(role)) {
  console.error(`Usage: npm run operator:role -- <email> <${ROLES.join('|')}>`);
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquant');
  process.exit(2);
}
const sql = createDb(url, 1);
try {
  await migrate(sql);
  const rows = await sql`UPDATE operators SET role = ${role} WHERE email = ${email.trim().toLowerCase()} RETURNING id`;
  if (!rows.length) {
    console.error(`Aucun accès pour ${email}.`);
    process.exit(1);
  }
  await sql`INSERT INTO audit_log (operator_id, action, detail) VALUES (${rows[0]!.id}, 'operator.role', ${sql.json({ role, via: 'cli' } as never)})`;
  console.log(`${email.toLowerCase()} : ${ROLE_LABELS[role]}.`);
} finally {
  await sql.end({ timeout: 2 });
}
