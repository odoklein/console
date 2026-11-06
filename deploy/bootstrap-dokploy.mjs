// Deploy (or redeploy) the Console agences in Dokploy, on the server, next to the agencies infra
// created by the CRM's scripts/provision-agency/server/bootstrap-infra.mjs (reads /root/provision/infra.env).
//   docker buildx build --push -t 127.0.0.1:5000/console-agences:<sha> .   (from this folder)
//   node deploy/bootstrap-dokploy.mjs <console image tag> <CRM tag new agencies start on>
//   - its own private Postgres 17 (console-pg), never an agency database
//   - the app from the local registry, with the Docker socket, the proxy's dynamic dir and the shared env mounted
//   - its address console.<platform domain> (plain http in Dokploy, TLS at the public proxy)
// Idempotent. Secrets go to /root/provision/console.env (mode 600) and are never printed.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";

const TAG = process.argv[2];
const CRM_TAG = process.argv[3];
if (!TAG || !CRM_TAG) throw new Error("usage: node bootstrap-console.mjs <console image tag> <default crm tag>");
const hex = (n) => randomBytes(n).toString("hex");
const parse = (f) => Object.fromEntries(existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]) : []);
const infra = parse("/root/provision/infra.env");
const mine = parse("/root/provision/console.env");
const KEY = infra.PROVISION_DOKPLOY_API_KEY;
const BASE = "http://127.0.0.1:3000/api";
const H = { "x-api-key": KEY, "content-type": "application/json", accept: "application/json" };
const log = (s) => console.log(s);

async function call(method, route, body, query) {
    const res = await fetch(`${BASE}/${route}${query ? "?" + new URLSearchParams(query) : ""}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`${route} -> ${res.status}: ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { return text; }
}

const registry = await (await fetch(`http://127.0.0.1:5000/v2/console-agences/tags/list`)).json().catch(() => ({}));
if (!(registry.tags || []).includes(TAG)) throw new Error(`image console-agences:${TAG} is not in the local registry yet`);

const projects = await call("GET", "project.all");
let project = projects.find((p) => p.name === (infra.PROVISION_DOKPLOY_PROJECT || "agencies"));
const environment = project.environments.find((e) => e.isDefault) || project.environments[0];
const environmentId = environment.environmentId;
const refresh = async () => (await call("GET", "project.all")).find((p) => p.name === project.name).environments.find((e) => e.environmentId === environmentId);

// ---- Console's own Postgres ----
async function findPg() {
    for (const p of (await refresh()).postgres || []) {
        const info = await call("GET", "postgres.one", undefined, { postgresId: p.postgresId });
        if (info.name === "console-pg") return info;
    }
    return null;
}
let pg = await findPg();
if (!pg) {
    await call("POST", "postgres.create", { name: "console-pg", appName: "console-pg", databaseName: "console", databaseUser: "console", databasePassword: hex(24), dockerImage: "postgres:17", environmentId, description: "Console agences database" });
    pg = await findPg();
    log("console-pg created");
} else log("console-pg exists");
// Deploy the database only when it is new or not up. Redeploying a running console-pg restarts it
// while the app below starts: the app dies on ENOTFOUND console-pg-* and Swarm rolls it back.
if (pg.applicationStatus !== "done") {
    await call("POST", "postgres.deploy", { postgresId: pg.postgresId });
    for (let i = 0; ; i++) {
        const status = (await call("GET", "postgres.one", undefined, { postgresId: pg.postgresId })).applicationStatus;
        if (status === "done") break;
        if (status === "error" || i >= 60) throw new Error(`console-pg did not come up (status ${status})`);
        await new Promise((r) => setTimeout(r, 3000));
    }
    log("console-pg deployed");
} else log("console-pg running, left as is");

// ---- secrets kept across runs ----
const encryptionKey = mine.CONSOLE_ENCRYPTION_KEY || hex(32);
const platform = infra.PROVISION_PLATFORM_DOMAIN;
const host = `console.${platform}`;
const env = {
    DATABASE_URL: `postgresql://console:${pg.databasePassword}@${pg.appName}:5432/console`,
    DB_POOL_MAX: "10",
    PORT: "3100",
    CONSOLE_URL: `https://${host}`,
    CONSOLE_ENCRYPTION_KEY: encryptionKey,
    LOG_LEVEL: "info",
    PROVISION_PLATFORM_DOMAIN: platform,
    PROVISION_PG_ADMIN_URL: infra.PROVISION_PG_ADMIN_URL,
    PROVISION_MINIO_ENDPOINT: infra.PROVISION_MINIO_ENDPOINT,
    PROVISION_MINIO_ACCESS_KEY_ID: infra.PROVISION_MINIO_ACCESS_KEY_ID,
    PROVISION_MINIO_SECRET_ACCESS_KEY: infra.PROVISION_MINIO_SECRET_ACCESS_KEY,
    PROVISION_DOKPLOY_URL: infra.PROVISION_DOKPLOY_URL,
    PROVISION_DOKPLOY_API_KEY: KEY,
    PROVISION_DOKPLOY_PROJECT: infra.PROVISION_DOKPLOY_PROJECT || "agencies",
    PROVISION_IMAGE_REPO: infra.PROVISION_IMAGE_REPO,
    PROVISION_DEFAULT_TAG: CRM_TAG,
    PROVISION_DOCKER_NETWORK: "dokploy-network",
    PROVISION_PROXY_DYNAMIC_DIR: "/data/coolify/proxy/dynamic",
    PROVISION_SHARED_ENV: "/run/console/shared.env",
    BACKUP_BUCKET: "console-backups",
};
writeFileSync("/root/provision/console.env", Object.entries({ ...env }).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
chmodSync("/root/provision/console.env", 0o600);
log("wrote /root/provision/console.env (mode 600)");

// ---- the application ----
let app = (await refresh()).applications.find((a) => a.name === "console-agences");
if (!app) {
    await call("POST", "application.create", { name: "console-agences", appName: "console-agences", environmentId, description: "Console agences (team tool)" });
    app = (await refresh()).applications.find((a) => a.name === "console-agences");
    log("console-agences application created");
}
const id = app.applicationId;
await call("POST", "application.saveDockerProvider", { applicationId: id, dockerImage: `127.0.0.1:5000/console-agences:${TAG}`, username: null, password: null, registryUrl: null });
await call("POST", "application.saveEnvironment", { applicationId: id, env: Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", buildArgs: null, buildSecrets: null, createEnvFile: true });
const info = await call("GET", "application.one", undefined, { applicationId: id });
const haveMounts = new Set((info.mounts || []).map((m) => m.mountPath));
for (const [hostPath, mountPath] of [["/var/run/docker.sock", "/var/run/docker.sock"], ["/data/coolify/proxy/dynamic", "/data/coolify/proxy/dynamic"], ["/root/provision/shared.env", "/run/console/shared.env"]]) {
    if (haveMounts.has(mountPath)) continue;
    await call("POST", "mounts.create", { type: "bind", hostPath, mountPath, serviceType: "application", serviceId: id });
    log("mount " + hostPath + " -> " + mountPath);
}
const domains = await call("GET", "domain.byApplicationId", undefined, { applicationId: id });
if (!domains.some((d) => d.host === host)) {
    await call("POST", "domain.create", { host, port: 3100, https: false, certificateType: "none", applicationId: id, domainType: "application" });
    log("domain " + host);
}

// ---- public proxy route (TLS ends here) ----
const rid = "console-agences";
writeFileSync(`/data/coolify/proxy/dynamic/${rid}.yml`, [
    "# Written by bootstrap-console. Routes the Console's address through Coolify's proxy to Dokploy's Traefik.",
    "http:", "  routers:", `    ${rid}-http:`, "      entryPoints:", "        - http", `      rule: Host(\`${host}\`)`, `      service: ${rid}-dokploy`, "      middlewares:", `        - ${rid}-https`,
    `    ${rid}-https:`, "      entryPoints:", "        - https", `      rule: Host(\`${host}\`)`, `      service: ${rid}-dokploy`, "      tls:", "        certResolver: letsencrypt",
    "  services:", `    ${rid}-dokploy:`, "      loadBalancer:", "        passHostHeader: true", "        servers:", "          - url: http://dokploy-traefik:80",
    "  middlewares:", `    ${rid}-https:`, "      redirectScheme:", "        scheme: https", "        permanent: true", "",
].join("\n"));
log("proxy route written for " + host);

await call("POST", "application.deploy", { applicationId: id, title: `console ${TAG}` });
log("deploy requested (Dokploy runs one deploy at a time)");
log("console url: https://" + host);
