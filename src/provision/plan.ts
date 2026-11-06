// ============================================
// VENDORED from the CRM repo, scripts/provision-agency/plan.ts (unchanged apart from
// this header). Keep the two in step.
//
// PROVISION AGENCY (pure) — everything that can be decided without touching a
// server: validation, resource names, secrets, the instance env, env-file text.
// The orchestration is in ./run.ts, the real servers in ./real.ts.
// ============================================

import { randomBytes } from "node:crypto";

// ---------- agency config (agency.json) ----------

export type AgencyConfig = {
    /** Lowercase slug: becomes the database, bucket, app and sub-domain name. */
    slug: string;
    /** Display name, e.g. "Agence Nord". */
    name: string;
    companyName?: string;
    companyShortName?: string;
    manager: { email: string; name: string };
    /** Agency's own domain ("crm.agence-nord.fr"). Optional: the platform address always works. */
    domain?: string;
    brand?: {
        productName?: string;
        tagline?: string;
        description?: string;
        senderName?: string;
        notificationsAddress?: string;
        supportAddress?: string;
        website?: string;
        emailDomains?: string[];
        lang?: string;
        locale?: string;
        currency?: string;
        timeZone?: string;
        primaryColor?: string;
        accentColor?: string;
        neutralTint?: number;
        fontPreset?: string;
    };
    /** Paths (relative to agency.json) per logo slot. */
    logos?: Partial<Record<LogoSlot, string>>;
    license?: {
        plan?: string | null;
        seatLimit?: number | null;
        features?: Record<string, boolean>;
        aiMonthlyQuota?: number | null;
    };
};

export const LOGO_SLOTS = ["full", "fullInverse", "mark", "markInverse", "favicon", "appleTouchIcon"] as const;
export type LogoSlot = (typeof LOGO_SLOTS)[number];

const SLUG = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESERVED_SLUGS = new Set(["admin", "api", "app", "auth", "console", "edge", "www", "mail", "demo-template"]);

export type ConfigCheck = { ok: true; value: AgencyConfig } | { ok: false; errors: string[] };

export function validateAgencyConfig(input: unknown): ConfigCheck {
    const errors: string[] = [];
    if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["agency.json doit contenir un objet"] };
    const c = input as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

    const slug = str(c.slug);
    if (!SLUG.test(slug)) errors.push("slug: 3 à 32 caractères, minuscules, chiffres et tirets, commence par une lettre (ex. agence-nord)");
    else if (RESERVED_SLUGS.has(slug)) errors.push(`slug: « ${slug} » est réservé`);
    if (!str(c.name)) errors.push("name: nom de l'agence requis");

    const manager = c.manager as Record<string, unknown> | undefined;
    if (!manager || !EMAIL.test(str(manager.email))) errors.push("manager.email: adresse email valide requise");
    if (!manager || !str(manager.name)) errors.push("manager.name: nom du premier manager requis");

    if (c.domain != null && !HOST.test(str(c.domain).toLowerCase())) errors.push("domain: nom de domaine invalide (ex. crm.agence-nord.fr)");

    if (c.logos != null) {
        if (typeof c.logos !== "object" || Array.isArray(c.logos)) errors.push("logos: un objet { emplacement: chemin } est attendu");
        else for (const k of Object.keys(c.logos as object)) if (!(LOGO_SLOTS as readonly string[]).includes(k)) errors.push(`logos.${k}: emplacement inconnu (${LOGO_SLOTS.join(", ")})`);
    }
    if (errors.length) return { ok: false, errors };

    const value = { ...(c as unknown as AgencyConfig), slug, name: str(c.name), domain: c.domain ? str(c.domain).toLowerCase() : undefined };
    value.manager = { email: str(manager!.email).toLowerCase(), name: str(manager!.name) };
    return { ok: true, value };
}

// ---------- derived names ----------

export type Names = {
    slug: string;
    dbName: string;
    dbRole: string;
    bucket: string;
    appName: string;
    /** Immediate address, works as soon as the wildcard DNS and the container are up. */
    platformHost: string;
};

const PG_IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export function deriveNames(slug: string, platformDomain: string): Names {
    const us = slug.replace(/-/g, "_");
    const names: Names = {
        slug,
        dbName: `db_${us}`,
        dbRole: `agency_${us}`,
        bucket: slug,
        appName: `crm-${slug}`,
        platformHost: `${slug}.${platformDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, "")}`,
    };
    if (!PG_IDENT.test(names.dbName) || !PG_IDENT.test(names.dbRole)) throw new Error("unsafe_pg_identifier");
    if (!HOST.test(names.platformHost)) throw new Error(`invalid_platform_domain:${platformDomain}`);
    return names;
}

// ---------- secrets ----------

export type Secrets = {
    dbPassword: string;
    nextauthSecret: string;
    encryptionKey: string;
    instanceAdminSecret: string;
    cronSecret: string;
    /** 40 hex chars: MinIO secret keys are 8 to 40 characters. */
    minioSecret: string;
};

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

export function generateSecrets(): Secrets {
    return {
        dbPassword: hex(24),
        nextauthSecret: randomBytes(32).toString("base64url"),
        encryptionKey: hex(32),
        instanceAdminSecret: hex(32),
        cronSecret: hex(24),
        minioSecret: hex(20),
    };
}

// ---------- urls and env ----------

export type PgTarget = { host: string; port: number; params?: string };

export function buildDatabaseUrl(names: Names, secrets: Secrets, pg: PgTarget): string {
    const q = pg.params ? `?${pg.params.replace(/^\?/, "")}` : "";
    return `postgresql://${names.dbRole}:${secrets.dbPassword}@${pg.host}:${pg.port}/${names.dbName}${q}`;
}

export type MinioTarget = { endpoint: string; accessKeyId: string; secretAccessKey: string; region?: string };

export function buildInstanceEnv(input: {
    names: Names;
    secrets: Secrets;
    primaryHost: string;
    pg: PgTarget;
    minio: MinioTarget;
    /** KEY=VALUE shared by every agency (SMTP, platform AI keys, OAuth apps, relay, socket). */
    shared: Record<string, string>;
}): Record<string, string> {
    const url = buildDatabaseUrl(input.names, input.secrets, input.pg);
    // A blank line in the shared file ("GOOGLE_CLIENT_ID=") means "not set": leave the key out.
    const shared = Object.fromEntries(Object.entries(input.shared).filter(([, v]) => v.trim() !== ""));
    const env: Record<string, string> = {
        ...shared,
        NODE_ENV: "production",
        DATABASE_URL: url,
        DIRECT_URL: url,
        NEXTAUTH_URL: `https://${input.primaryHost}`,
        NEXTAUTH_SECRET: input.secrets.nextauthSecret,
        ENCRYPTION_KEY: input.secrets.encryptionKey,
        INSTANCE_ADMIN_SECRET: input.secrets.instanceAdminSecret,
        INSTANCE_ID: input.names.slug,
        CRON_SECRET: input.secrets.cronSecret,
        MINIO_ENDPOINT: input.minio.endpoint,
        MINIO_ACCESS_KEY_ID: input.minio.accessKeyId,
        MINIO_SECRET_ACCESS_KEY: input.minio.secretAccessKey,
        MINIO_BUCKET: input.names.bucket,
        PORT: "5000",
    };
    if (input.minio.region) env.MINIO_REGION = input.minio.region;
    return env;
}

/** Keys the per-agency values above must never be overridden by the shared file. */
export const PROTECTED_KEYS = [
    "DATABASE_URL", "DIRECT_URL", "NEXTAUTH_URL", "NEXTAUTH_SECRET", "ENCRYPTION_KEY", "INSTANCE_ADMIN_SECRET",
    "INSTANCE_ID", "CRON_SECRET", "MINIO_BUCKET", "APP_URL", "NEXT_PUBLIC_APP_URL",
] as const;

// ---------- env files ----------

export function parseEnvFile(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
    }
    return out;
}

/** dotenv text, the format Dokploy's environment box takes. */
export function toEnvFile(env: Record<string, string>): string {
    return (
        Object.entries(env)
            .map(([k, v]) => {
                if (/[\r\n]/.test(v)) throw new Error(`env_value_has_newline:${k}`);
                return /[\s#"'$]/.test(v) ? `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : `${k}=${v}`;
            })
            .join("\n") + "\n"
    );
}

// ---------- public proxy route ----------

/**
 * Traefik file-provider config for the proxy that owns ports 80/443. On our server that is
 * Coolify's proxy (Dokploy's own Traefik sits behind it on :8090), so a Dokploy domain alone is
 * not reachable: each agency needs its hosts routed to Dokploy's Traefik, which then routes by
 * Host to the app. Same shape as the hand-written files already in /data/coolify/proxy/dynamic.
 */
export function renderProxyRoute(slug: string, hosts: string[], upstream = "http://dokploy-traefik:80", resolver = "letsencrypt"): string {
    const uniq = [...new Set(hosts)];
    if (!uniq.length || !uniq.every((h) => HOST.test(h))) throw new Error("invalid_proxy_hosts");
    const rule = uniq.map((h) => `Host(\`${h}\`)`).join(" || ");
    const id = `agency-${slug}`;
    return [
        "# Written by provision-agency. Safe to delete only together with the agency.",
        "http:",
        "  routers:",
        `    ${id}-http:`,
        "      entryPoints:",
        "        - http",
        `      rule: ${rule}`,
        `      service: ${id}-dokploy`,
        "      middlewares:",
        `        - ${id}-https`,
        `    ${id}-https:`,
        "      entryPoints:",
        "        - https",
        `      rule: ${rule}`,
        `      service: ${id}-dokploy`,
        "      tls:",
        `        certResolver: ${resolver}`,
        "  services:",
        `    ${id}-dokploy:`,
        "      loadBalancer:",
        "        passHostHeader: true",
        "        servers:",
        `          - url: ${upstream}`,
        "  middlewares:",
        `    ${id}-https:`,
        "      redirectScheme:",
        "        scheme: https",
        "        permanent: true",
        "",
    ].join("\n");
}

// ---------- API payloads ----------

export function brandPayload(config: AgencyConfig, primaryHost: string): Record<string, unknown> {
    const b = config.brand ?? {};
    const payload: Record<string, unknown> = {
        name: config.name,
        productName: b.productName ?? config.name,
        companyName: config.companyName ?? config.name,
        companyShortName: config.companyShortName ?? config.name,
        senderName: b.senderName ?? config.name,
        appUrl: `https://${primaryHost}`,
        ...b,
    };
    // `appUrl` is where the instance is, never something the config can contradict.
    payload.appUrl = `https://${primaryHost}`;
    return payload;
}

export function licensePayload(config: AgencyConfig): Record<string, unknown> | null {
    const l = config.license;
    if (!l) return null;
    const out: Record<string, unknown> = {};
    for (const k of ["plan", "seatLimit", "features", "aiMonthlyQuota"] as const) if (k in l) out[k] = l[k];
    return Object.keys(out).length ? out : null;
}

/** multipart/form-data body for POST /api/instance/brand/assets, built by hand so the signed bytes are the sent bytes. */
export function multipartLogo(slot: LogoSlot, filename: string, contentType: string, data: Uint8Array, boundary = `----cp${randomBytes(8).toString("hex")}`) {
    const safe = filename.replace(/[^\w.\-]/g, "_");
    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="slot"\r\n\r\n${slot}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safe}"\r\nContent-Type: ${contentType}\r\n\r\n`),
        Buffer.from(data),
        Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

export function logoContentType(file: string): string | null {
    const ext = file.toLowerCase().split(".").pop();
    return ext === "png" ? "image/png" : ext === "svg" ? "image/svg+xml" : ext === "webp" ? "image/webp" : null;
}
