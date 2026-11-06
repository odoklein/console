// ============================================
// VENDORED from the CRM repo, scripts/provision-agency/dokploy.ts. Keep the two in step:
// a fix to a Dokploy call here belongs there too. Console additions: stop, start,
// deleteApplication (Phase 3 operations); no parameter properties (Node type stripping).
//
// DOKPLOY CLIENT — the few calls provisioning needs. Auth: `x-api-key` header
// (Dokploy > Settings > Profile > API/CLI). Routes are `POST|GET <base>/api/<router>.<procedure>`.
//
// Written against the public API reference; the response SHAPES are not fully
// documented, so every lookup is tolerant (several places an id may appear) and
// falls back to listing the project. If a call fails, the error carries the
// route, status and body: compare with your instance's Swagger UI
// (<dokploy>/swagger) and fix the one call.
// ============================================

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class DokployError extends Error {
    route: string;
    status: number;
    body: string;

    constructor(route: string, status: number, body: string) {
        super(`dokploy ${route} -> ${status}: ${body.slice(0, 300)}`);
        this.route = route;
        this.status = status;
        this.body = body;
    }
}

type Json = Record<string, unknown>;

export class DokployClient {
    private base: string;
    private apiKey: string;
    private fetchImpl: FetchLike;

    constructor(base: string, apiKey: string, fetchImpl: FetchLike = fetch as unknown as FetchLike) {
        this.base = base.replace(/\/+$/, "");
        this.apiKey = apiKey;
        this.fetchImpl = fetchImpl;
    }

    private async call(method: "GET" | "POST", route: string, body?: Json, query?: Record<string, string>): Promise<unknown> {
        const qs = query ? `?${new URLSearchParams(query)}` : "";
        const res = await this.fetchImpl(`${this.base}/api/${route}${qs}`, {
            method,
            headers: { "x-api-key": this.apiKey, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        if (!res.ok) throw new DokployError(route, res.status, text);
        if (!text) return {};
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }

    /** The default environment of a project (named in the config, e.g. "agencies"), created when missing. */
    async findEnvironmentId(projectName: string): Promise<string> {
        const list = (await this.call("GET", "project.all")) as Json[];
        let project = Array.isArray(list) ? list.find((p) => p.name === projectName) : undefined;
        if (!project) {
            const created = (await this.call("POST", "project.create", { name: projectName, description: "Agency CRM instances (provision-agency)" })) as Json;
            const again = (await this.call("GET", "project.all")) as Json[];
            project = again.find((p) => p.name === projectName) ?? (created.project as Json | undefined);
            if (!project) throw new Error(`dokploy: project « ${projectName} » introuvable après création`);
        }
        const envs = (project.environments as Json[] | undefined) ?? [];
        const env = envs.find((e) => e.isDefault === true) ?? envs.find((e) => e.name === "production") ?? envs[0];
        const id = env?.environmentId;
        if (typeof id !== "string") throw new Error(`dokploy: aucun environnement dans le projet « ${projectName} » (renseignez DOKPLOY_ENVIRONMENT_ID)`);
        return id;
    }

    /** An application of that app name in the project, or null. */
    async findApplication(projectName: string, appName: string): Promise<string | null> {
        const list = (await this.call("GET", "project.all")) as Json[];
        const project = Array.isArray(list) ? list.find((p) => p.name === projectName) : undefined;
        const envs = (project?.environments as Json[] | undefined) ?? [];
        for (const e of envs) {
            for (const a of (e.applications as Json[] | undefined) ?? []) {
                if (a.name === appName || a.appName === appName || String(a.appName ?? "").startsWith(`${appName}-`)) return String(a.applicationId);
            }
        }
        return null;
    }

    async createApplication(input: { name: string; environmentId: string; description?: string }): Promise<string> {
        const res = (await this.call("POST", "application.create", { name: input.name, environmentId: input.environmentId, description: input.description })) as Json;
        const id = pickId(res, "applicationId");
        if (id) return id;
        throw new Error("dokploy: application.create n'a pas renvoyé d'applicationId; relancez, l'application sera retrouvée par son nom");
    }

    saveDockerProvider(input: { applicationId: string; dockerImage: string; username?: string; password?: string; registryUrl?: string }) {
        return this.call("POST", "application.saveDockerProvider", {
            applicationId: input.applicationId,
            dockerImage: input.dockerImage,
            username: input.username ?? null,
            password: input.password ?? null,
            registryUrl: input.registryUrl ?? null,
        });
    }

    saveEnvironment(applicationId: string, env: string) {
        return this.call("POST", "application.saveEnvironment", { applicationId, env, buildArgs: null, buildSecrets: null, createEnvFile: true });
    }

    createDomain(input: { applicationId: string; host: string; port: number }) {
        return this.call("POST", "domain.create", {
            host: input.host,
            port: input.port,
            // Plain HTTP on purpose: TLS ends at the public proxy; an https domain makes Dokploy's Traefik
            // redirect http to https in an endless 308 loop behind it (seen on the first real run).
            https: false,
            certificateType: "none",
            applicationId: input.applicationId,
            domainType: "application",
        });
    }

    async listDomains(applicationId: string): Promise<string[]> {
        const res = (await this.call("GET", "domain.byApplicationId", undefined, { applicationId })) as Json[];
        return Array.isArray(res) ? res.map((d) => String(d.host)) : [];
    }

    deploy(applicationId: string, title: string) {
        return this.call("POST", "application.deploy", { applicationId, title });
    }

    stop(applicationId: string) {
        return this.call("POST", "application.stop", { applicationId });
    }

    start(applicationId: string) {
        return this.call("POST", "application.start", { applicationId });
    }

    /** Removes the application, its container and its Dokploy domains. */
    deleteApplication(applicationId: string) {
        return this.call("POST", "application.delete", { applicationId });
    }
}

/** An id may come bare, nested under `data`, or in a tRPC-style envelope. */
export function pickId(res: unknown, key: string): string | null {
    const seen: unknown[] = [res];
    while (seen.length) {
        const cur = seen.shift();
        if (!cur || typeof cur !== "object") continue;
        const o = cur as Json;
        if (typeof o[key] === "string") return o[key] as string;
        for (const k of ["data", "result", "json", "application"]) if (o[k]) seen.push(o[k]);
    }
    return null;
}
