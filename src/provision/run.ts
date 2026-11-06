// ============================================
// VENDORED from the CRM repo, scripts/provision-agency/run.ts. Keep the two in step.
// Console additions: Deps.onStep (live checklist), Deps.onInvite (the invite link is
// handed over instead of logged), stepCatalog().
//
// PROVISION AGENCY (orchestration) — the ten steps of docs/AGENCY_PROVISIONING_PLAN.md §3C,
// as idempotent steps over injected servers (./real.ts in production, fakes in tests).
//
// State lives in provision-out/<slug>.json (secrets included, mode 0600, git-ignored).
// A step already marked done is skipped, so a failed run is resumed by running the
// same command again. Steps never delete anything.
// ============================================

import { createHash } from "node:crypto";
import {
    brandPayload,
    buildInstanceEnv,
    deriveNames,
    generateSecrets,
    licensePayload,
    logoContentType,
    multipartLogo,
    renderProxyRoute,
    toEnvFile,
    PROTECTED_KEYS,
    LOGO_SLOTS,
    type AgencyConfig,
    type MinioTarget,
    type Names,
    type PgTarget,
    type Secrets,
} from "./plan.ts";
import type { DokployClient } from "./dokploy.ts";

export type State = {
    slug: string;
    createdAt: string;
    secrets: Secrets;
    primaryHost: string;
    steps: Record<string, "done" | "pending">;
    dokployAppId?: string;
    domains: string[];
    /** Tag the Dokploy app was last configured with / deployed with. */
    imageTag?: string;
    deployedTag?: string;
    migratedTag?: string;
    seededTag?: string;
    /** Bucket-scoped key, when the storage can mint one. */
    minio?: { accessKeyId: string; secretAccessKey: string };
};

export type InstanceResponse = { status: number; json: any };

export interface Deps {
    pg: {
        roleExists(role: string): Promise<boolean>;
        databaseExists(db: string): Promise<boolean>;
        createRole(role: string, password: string): Promise<void>;
        setRolePassword(role: string, password: string): Promise<void>;
        createDatabase(db: string, owner: string): Promise<void>;
    };
    storage: {
        ensureBucket(bucket: string): Promise<void>;
        /** Optional: an access key that can only touch this bucket. Absent = the shared admin key is used (less safe). */
        scopedKey?(bucket: string, accessKeyId: string, secretAccessKey: string): Promise<void>;
    };
    /** Runs `prisma migrate deploy` or the instance seed against the agency database. */
    runDbJob(job: "migrate" | "seed", input: { databaseUrl: string; directUrl: string; image: string }): Promise<void>;
    dokploy: Pick<DokployClient, "findEnvironmentId" | "findApplication" | "createApplication" | "saveDockerProvider" | "saveEnvironment" | "createDomain" | "listDomains" | "deploy">;
    /** Signed call to the agency instance. */
    instance(baseUrl: string, secret: string): (method: string, pathWithQuery: string, body?: Uint8Array | string, headers?: Record<string, string>) => Promise<InstanceResponse>;
    /** resolve4 is optional: with it, a domain whose A records point at the edge's address is accepted too. */
    dns: { resolveCname(host: string): Promise<string[]>; resolve4?(host: string): Promise<string[]> };
    /** Public proxy (the one on ports 80/443). Absent = the route is printed for manual placement. */
    proxy?: { writeRoute(slug: string, content: string): Promise<string> };
    readFile(path: string): Promise<Uint8Array>;
    log(line: string): void;
    /** Called when a step starts (result "running") and when it ends. */
    onStep?(step: { id: string; label: string; result: StepResult | "running" | "skipped" | "failed"; note?: string }): void | Promise<void>;
    /** Receives the manager's invite link; when set, the link is not written to the log. */
    onInvite?(input: { email: string; name: string; inviteUrl: string; expiresAt?: string }): void | Promise<void>;
    sleep(ms: number): Promise<void>;
    now(): Date;
}

export type RunOptions = {
    config: AgencyConfig;
    /** Directory of agency.json, for logo paths. */
    configDir: string;
    platformDomain: string;
    /** Host (as the agency containers see it) and port of the Postgres cluster. */
    pg: PgTarget;
    minio: MinioTarget;
    shared: Record<string, string>;
    imageRepo: string; // ghcr.io/odoklein/captainprospect-crm
    imageTag: string;
    dokployProject: string;
    dokployEnvironmentId?: string;
    registry?: { username: string; password: string; url: string };
    /** Base URL to reach the instance; default https://<primaryHost> (tests and tunnels override). */
    baseUrlOverride?: string;
    only?: string[];
    healthTimeoutMs?: number;
};

type Ctx = { o: RunOptions; d: Deps; names: Names; state: State; save(): Promise<void> };
type StepResult = "done" | "pending";
type Step = { id: string; label: string; run(c: Ctx): Promise<StepResult | { result: StepResult; note?: string }> };

const secretKeysOf = (s: Secrets) => Object.values(s);


function envFor(c: Ctx): Record<string, string> {
    const shared = Object.fromEntries(Object.entries(c.o.shared).filter(([k]) => !(PROTECTED_KEYS as readonly string[]).includes(k)));
    return buildInstanceEnv({ names: c.names, secrets: c.state.secrets, primaryHost: c.state.primaryHost, pg: c.o.pg, minio: { ...c.o.minio, ...c.state.minio }, shared });
}

function baseUrl(c: Ctx): string {
    return c.o.baseUrlOverride ?? `https://${c.state.primaryHost}`;
}

function api(c: Ctx) {
    return c.d.instance(baseUrl(c), c.state.secrets.instanceAdminSecret);
}

function fail(what: string, res: InstanceResponse): never {
    throw new Error(`${what}: HTTP ${res.status} ${JSON.stringify(res.json)?.slice(0, 400)}`);
}

async function ensureApplication(c: Ctx): Promise<string> {
    if (c.state.dokployAppId) return c.state.dokployAppId;
    const envId = c.o.dokployEnvironmentId ?? (await c.d.dokploy.findEnvironmentId(c.o.dokployProject));
    const existing = await c.d.dokploy.findApplication(c.o.dokployProject, c.names.appName);
    c.state.dokployAppId = existing ?? (await c.d.dokploy.createApplication({ name: c.names.appName, environmentId: envId, description: `Agence ${c.o.config.name}` }));
    await c.save();
    return c.state.dokployAppId;
}

/** Route every host of the agency through the public proxy to Dokploy's Traefik. */
async function publishRoute(c: Ctx): Promise<StepResult | { result: StepResult; note?: string }> {
    const yaml = renderProxyRoute(c.names.slug, c.state.domains);
    if (!c.d.proxy) {
        return { result: "pending", note: `aucun proxy configuré (PROVISION_PROXY_DYNAMIC_DIR): placez ce fichier à la main dans le dossier dynamique du proxy public:\n${yaml}` };
    }
    const file = await c.d.proxy.writeRoute(c.names.slug, yaml);
    return { result: "done", note: `${c.state.domains.join(", ")} -> ${file}` };
}

/**
 * Gives the instance its new public URL. The redeploy that just started restarts it, so the proxy answers
 * 502/503 (or 404 before the new router exists) for a while: retry those until the health timeout.
 * Sent through the platform address, which always stays attached and has its certificate.
 */
async function sendAppUrl(c: Ctx, domain: string): Promise<void> {
    const call = c.d.instance(`https://${c.names.platformHost}`, c.state.secrets.instanceAdminSecret);
    const deadline = c.d.now().getTime() + (c.o.healthTimeoutMs ?? 6 * 60_000);
    for (;;) {
        let res: InstanceResponse;
        try {
            res = await call("PUT", "/api/instance/brand", JSON.stringify({ appUrl: `https://${domain}` }), { "Content-Type": "application/json" });
        } catch (err) {
            res = { status: 0, json: err instanceof Error ? err.message : String(err) };
        }
        if (res.status === 200) return;
        if (![0, 404, 502, 503, 504].includes(res.status) || c.d.now().getTime() >= deadline) fail("PUT /api/instance/brand (appUrl)", res);
        await c.d.sleep(10_000);
    }
}

/** An A record instead of the CNAME is fine as long as every address it gives is one of the edge's. */
async function pointsAtEdge(c: Ctx, domain: string, edge: string): Promise<boolean> {
    if (!c.d.dns.resolve4) return false;
    const [own, target] = await Promise.all([c.d.dns.resolve4(domain).catch((): string[] => []), c.d.dns.resolve4(edge).catch((): string[] => [])]);
    return own.length > 0 && own.every((ip) => target.includes(ip));
}

/** Step ids and labels in run order, for a checklist drawn before the run starts. */
export function stepCatalog(): { id: string; label: string }[] {
    return STEPS.map(({ id, label }) => ({ id, label }));
}

export const STEP_IDS = ["database", "storage", "migrate", "seed", "app", "route", "deploy", "health", "brand", "license", "logos", "custom-domain", "bootstrap"] as const;

const STEPS: Step[] = [
    {
        id: "database",
        label: "Base de données créée",
        async run(c) {
            const { pg } = c.d;
            if (!(await pg.roleExists(c.names.dbRole))) await pg.createRole(c.names.dbRole, c.state.secrets.dbPassword);
            else await pg.setRolePassword(c.names.dbRole, c.state.secrets.dbPassword);
            if (!(await pg.databaseExists(c.names.dbName))) await pg.createDatabase(c.names.dbName, c.names.dbRole);
            return "done";
        },
    },
    {
        id: "storage",
        label: "Stockage créé",
        async run(c) {
            await c.d.storage.ensureBucket(c.names.bucket);
            if (c.d.storage.scopedKey) {
                const key = c.state.minio ?? { accessKeyId: `agency-${c.names.slug.slice(0, 8)}-${createHash("sha1").update(c.names.slug).digest("hex").slice(0, 4)}`, secretAccessKey: c.state.secrets.minioSecret };
                await c.d.storage.scopedKey(c.names.bucket, key.accessKeyId, key.secretAccessKey);
                c.state.minio = key;
                return { result: "done", note: "clé d'accès limitée à ce seul bucket" };
            }
            return { result: "done", note: "ATTENTION: la clé administrateur MinIO est partagée (PROVISION_MINIO_MC_ALIAS absent)" };
        },
    },
    {
        id: "migrate",
        label: "Schéma installé (migrations)",
        async run(c) {
            const env = envFor(c);
            await c.d.runDbJob("migrate", { databaseUrl: env.DATABASE_URL!, directUrl: env.DIRECT_URL!, image: `${c.o.imageRepo}-migrate:${c.o.imageTag}` });
            c.state.migratedTag = c.o.imageTag;
            return "done";
        },
    },
    {
        id: "seed",
        label: "Données de référence installées",
        async run(c) {
            const env = envFor(c);
            await c.d.runDbJob("seed", { databaseUrl: env.DATABASE_URL!, directUrl: env.DIRECT_URL!, image: `${c.o.imageRepo}-migrate:${c.o.imageTag}` });
            c.state.seededTag = c.o.imageTag;
            return "done";
        },
    },
    {
        id: "app",
        label: "Application créée dans Dokploy",
        async run(c) {
            const id = await ensureApplication(c);
            // Re-saved on every run: this is how a new tag or a changed shared env reaches the app.
            await c.d.dokploy.saveDockerProvider({
                applicationId: id,
                dockerImage: `${c.o.imageRepo}:${c.o.imageTag}`,
                username: c.o.registry?.username,
                password: c.o.registry?.password,
                registryUrl: c.o.registry?.url,
            });
            await c.d.dokploy.saveEnvironment(id, toEnvFile(envFor(c)));
            const have = await c.d.dokploy.listDomains(id).catch(() => [] as string[]);
            for (const host of [c.names.platformHost]) {
                if (!have.includes(host)) await c.d.dokploy.createDomain({ applicationId: id, host, port: 5000 });
                if (!c.state.domains.includes(host)) c.state.domains.push(host);
            }
            c.state.imageTag = c.o.imageTag;
            return "done";
        },
    },
    {
        id: "route",
        label: "Route publique (proxy 80/443)",
        run: publishRoute,
    },
    {
        id: "deploy",
        label: "Application déployée",
        async run(c) {
            await c.d.dokploy.deploy(await ensureApplication(c), `provision ${c.o.imageTag}`);
            c.state.deployedTag = c.o.imageTag;
            return "done";
        },
    },
    {
        id: "health",
        label: "Instance en ligne (base jointe, schéma à jour)",
        async run(c) {
            const call = api(c);
            const deadline = c.d.now().getTime() + (c.o.healthTimeoutMs ?? 6 * 60_000);
            let last = "aucune réponse";
            for (;;) {
                try {
                    const res = await call("GET", "/api/instance/health");
                    if (res.status === 200 && res.json?.dbOk === true && res.json?.schemaVersion) {
                        c.d.log(`    version ${res.json.version}, schéma ${res.json.schemaVersion}`);
                        return "done";
                    }
                    last = `HTTP ${res.status} ${JSON.stringify(res.json)?.slice(0, 200)}`;
                } catch (err) {
                    last = err instanceof Error ? err.message : String(err);
                }
                if (c.d.now().getTime() >= deadline) throw new Error(`l'instance ne répond pas sur ${baseUrl(c)} (${last}). Vérifiez le déploiement Dokploy, le DNS et le certificat, puis relancez.`);
                await c.d.sleep(10_000);
            }
        },
    },
    {
        id: "brand",
        label: "Marque appliquée",
        async run(c) {
            const res = await api(c)("PUT", "/api/instance/brand", JSON.stringify(brandPayload(c.o.config, c.state.primaryHost)), { "Content-Type": "application/json" });
            if (res.status !== 200) fail("PUT /api/instance/brand", res);
            return "done";
        },
    },
    {
        id: "license",
        label: "Licence appliquée",
        async run(c) {
            const body = licensePayload(c.o.config);
            if (!body) return { result: "done", note: "pas de licence dans agency.json: illimité" };
            const res = await api(c)("PUT", "/api/instance/license", JSON.stringify(body), { "Content-Type": "application/json" });
            if (res.status !== 200) fail("PUT /api/instance/license", res);
            return "done";
        },
    },
    {
        id: "logos",
        label: "Logos envoyés",
        async run(c) {
            const logos = c.o.config.logos ?? {};
            const slots = LOGO_SLOTS.filter((s) => logos[s]);
            if (!slots.length) return { result: "done", note: "aucun logo: ceux de la plateforme restent" };
            for (const slot of slots) {
                const file = logos[slot]!;
                const type = logoContentType(file);
                if (!type) throw new Error(`logos.${slot}: ${file} doit être un PNG, SVG ou WebP`);
                const data = await c.d.readFile(`${c.o.configDir}/${file}`);
                const mp = multipartLogo(slot, file.split(/[\\/]/).pop()!, type, data);
                const res = await api(c)("POST", "/api/instance/brand/assets", mp.body, { "Content-Type": mp.contentType });
                if (res.status !== 200) fail(`logo ${slot}`, res);
                c.d.log(`    ${slot} ok`);
            }
            return "done";
        },
    },
    {
        id: "custom-domain",
        label: "Domaine de l'agence",
        async run(c) {
            const domain = c.o.config.domain;
            if (!domain) return { result: "done", note: "pas de domaine propre: l'adresse de la plateforme sert" };

            if (c.state.primaryHost !== domain) {
                const edge = `edge.${c.o.platformDomain}`;
                const cnames = (await c.d.dns.resolveCname(domain).catch(() => [])).map((h) => h.replace(/\.$/, "").toLowerCase());
                if (!cnames.includes(edge) && !(await pointsAtEdge(c, domain, edge))) {
                    return { result: "pending", note: `ajoutez chez le registrar de l'agence: CNAME ${domain} -> ${edge} (ou un enregistrement A vers l'adresse de ${edge}), puis relancez la commande (l'agence reste sur https://${c.state.primaryHost} en attendant)` };
                }
                const id = await ensureApplication(c);
                if (!(await c.d.dokploy.listDomains(id).catch(() => [] as string[])).includes(domain)) await c.d.dokploy.createDomain({ applicationId: id, host: domain, port: 5000 });
                if (!c.state.domains.includes(domain)) c.state.domains.push(domain);
                await publishRoute(c); // the public proxy must know the new host before DNS traffic arrives

                // The instance's own URL (cookies, OAuth, links in emails) follows the new address.
                c.state.primaryHost = domain;
                await c.d.dokploy.saveEnvironment(id, toEnvFile(envFor(c)));
                await c.d.dokploy.deploy(id, `domain ${domain}`);
                await c.save();
            }
            // Also on a re-run: the switch may have been saved while this call failed last time.
            await sendAppUrl(c, domain);
            return { result: "done", note: `adresse principale: https://${domain}` };
        },
    },
    {
        id: "bootstrap",
        label: "Premier manager créé",
        async run(c) {
            const m = c.o.config.manager;
            const res = await api(c)("POST", "/api/instance/bootstrap", JSON.stringify({ email: m.email, name: m.name }), { "Content-Type": "application/json" });
            if (res.status === 409) return { result: "done", note: "déjà créé (un utilisateur existe)" };
            if (res.status !== 201) fail("POST /api/instance/bootstrap", res);
            if (c.d.onInvite) {
                await c.d.onInvite({ email: m.email, name: m.name, inviteUrl: res.json.inviteUrl, expiresAt: res.json.expiresAt });
                return { result: "done", note: `invitation créée pour ${m.email}` };
            }
            c.d.log("");
            c.d.log(`    LIEN D'INVITATION (valable 24 h, affiché une seule fois) pour ${m.email}:`);
            c.d.log(`    ${res.json.inviteUrl}`);
            c.d.log("");
            return "done";
        },
    },
];

export type RunReport = { slug: string; primaryHost: string; steps: { id: string; label: string; result: StepResult | "skipped" | "failed"; note?: string }[]; ok: boolean };

export async function provision(o: RunOptions, d: Deps, store: { load(slug: string): Promise<State | null>; save(state: State): Promise<void> }): Promise<RunReport> {
    const names = deriveNames(o.config.slug, o.platformDomain);
    const state: State = (await store.load(o.config.slug)) ?? {
        slug: o.config.slug,
        createdAt: d.now().toISOString(),
        secrets: generateSecrets(),
        primaryHost: names.platformHost,
        steps: {},
        domains: [],
    };
    state.domains ??= [];
    const ctx: Ctx = { o, d, names, state, save: () => store.save(state) };
    await ctx.save();

    const report: RunReport = { slug: names.slug, primaryHost: state.primaryHost, steps: [], ok: true };
    const wanted = o.only?.length ? new Set(o.only) : null;
    if (wanted) for (const id of wanted) if (!(STEP_IDS as readonly string[]).includes(id)) throw new Error(`étape inconnue: ${id} (${STEP_IDS.join(", ")})`);

    let n = 0;
    for (const step of STEPS) {
        n++;
        const tag = `[${n}/${STEPS.length}] ${step.label}`;
        // Steps that run again on their own: migrations, seed, app config and deploy when the image
        // tag changed (an upgrade: migrations are additive and the seed idempotent), the health probe
        // every time, the domain while it is pending.
        const rerun =
            step.id === "health" ||
            (step.id === "migrate" && state.migratedTag !== o.imageTag) ||
            (step.id === "seed" && state.seededTag !== o.imageTag) ||
            (step.id === "app" && state.imageTag !== o.imageTag) ||
            (step.id === "deploy" && state.deployedTag !== o.imageTag);
        const alreadyDone = state.steps[step.id] === "done" && !rerun;
        if (wanted ? !wanted.has(step.id) : alreadyDone) {
            d.log(`${tag}: ${wanted ? "ignorée" : "déjà fait"}`);
            report.steps.push({ id: step.id, label: step.label, result: "skipped" });
            await d.onStep?.({ id: step.id, label: step.label, result: "skipped" });
            continue;
        }
        d.log(`${tag} ...`);
        await d.onStep?.({ id: step.id, label: step.label, result: "running" });
        try {
            const out = await step.run(ctx);
            const result = typeof out === "string" ? out : out.result;
            const note = typeof out === "string" ? undefined : out.note;
            state.steps[step.id] = result;
            await ctx.save();
            report.steps.push({ id: step.id, label: step.label, result, note });
            await d.onStep?.({ id: step.id, label: step.label, result, note });
            d.log(`    ${result === "done" ? "ok" : "EN ATTENTE"}${note ? `: ${note}` : ""}`);
        } catch (err) {
            const message = scrub(err instanceof Error ? err.message : String(err), state.secrets);
            report.steps.push({ id: step.id, label: step.label, result: "failed", note: message });
            await d.onStep?.({ id: step.id, label: step.label, result: "failed", note: message });
            report.ok = false;
            d.log(`    ÉCHEC: ${message}`);
            d.log(`    Corrigez puis relancez la même commande: les étapes déjà faites sont ignorées.`);
            break;
        }
    }
    report.primaryHost = state.primaryHost;
    return report;
}

/** Secrets never reach the console, even inside an error message. */
export function scrub(text: string, secrets: Secrets): string {
    let out = text;
    for (const s of secretKeysOf(secrets)) if (s.length >= 8) out = out.split(s).join("***");
    return out;
}
