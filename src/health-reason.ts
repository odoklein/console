// Shared by the pages and the alerts (scheduler): an offline instance described in operator words.

/**
 * Why an instance is offline, in words an operator can act on. The raw error stays in the
 * tooltip and the logs; the page shows the meaning ("fetch failed" says nothing to anyone).
 */
export function healthReason(error: string | null | undefined): string {
  const e = (error ?? '').trim();
  if (!e) return 'ne répond pas';
  if (/fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|other side closed/i.test(e)) return 'le serveur ne répond pas (arrêté, en redémarrage ou adresse injoignable)';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(e)) return 'l’adresse ne résout pas (DNS)';
  if (/timeout|timed out|aborted/i.test(e)) return 'le serveur met trop de temps à répondre';
  if (/certificate|CERT_|SSL|TLS/i.test(e)) return 'certificat HTTPS invalide ou pas encore émis';
  if (/\b401\b|invalid_signature/i.test(e)) return 'signature refusée (secret d’instance différent)';
  if (/\b503\b|not_configured/i.test(e)) return 'l’instance n’est pas configurée pour la Console (INSTANCE_ADMIN_SECRET)';
  if (/\b5\d\d\b/.test(e)) return 'erreur du serveur de l’agence';
  if (/dbOk|database/i.test(e)) return 'l’application tourne mais sa base de données est injoignable';
  return e;
}
