// First operator (or any later one) from the command line:
//   npm run operator:create -- prenom@exemple.fr "Prénom Nom"
// Prints a one-time setup link (72 h): the person chooses a password. The first account of an
// empty Console is the owner (Propriétaire); later ones are operators until changed on the Team page.

import { createOperator } from '../auth.ts';
import { createDb } from '../db.ts';
import { migrate } from '../migrate.ts';

const [email, ...nameParts] = process.argv.slice(2);
const name = nameParts.join(' ').trim();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) {
  console.error('Usage: npm run operator:create -- <email> "<Prénom Nom>"');
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
  const [exists] = await sql`SELECT 1 FROM operators WHERE email = ${email.toLowerCase()}`;
  if (exists) {
    console.error(`${email} a déjà un accès. Un autre membre de l’équipe peut lui générer un nouveau lien (page Équipe).`);
    process.exit(1);
  }
  const [owner] = await sql`SELECT 1 FROM operators WHERE role = 'owner' AND NOT disabled`;
  const role = owner ? 'operator' : 'owner';
  const { setupToken } = await createOperator(sql, email, name, role);
  const base = (process.env.CONSOLE_URL ?? 'http://localhost:3100').replace(/\/+$/, '');
  console.log(`Accès créé pour ${name} <${email.toLowerCase()}> (${role === 'owner' ? 'Propriétaire' : 'Opérateur'}).\nLien (valable 72 h, une seule fois) :\n${base}/setup/${setupToken}`);
} finally {
  await sql.end({ timeout: 2 });
}
