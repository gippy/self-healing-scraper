import { readFile } from 'node:fs/promises';

// DigitalOcean App Platform: one app per scraper, built from its folder in the public monorepo. A `git`
// source needs no GitHub app install, but doesn't deploy on push, so the factory triggers deployments itself.

const API = 'https://api.digitalocean.com/v2';

type Deployment = { id: string; phase?: string };
type App = {
    id: string;
    live_url?: string;
    default_ingress?: string;
    active_deployment?: Deployment;
    in_progress_deployment?: Deployment;
    pending_deployment?: Deployment;
};

async function call<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`DigitalOcean ${method} ${path} answered ${response.status}: ${text.slice(0, 400)}`);
    return (text ? JSON.parse(text) : {}) as T;
}

// App names: 2–32 characters, lowercase letters, digits and dashes, starting with a letter.
export function getAppName(scraper: string): string {
    return `scraper-${scraper}`.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-').slice(0, 32).replace(/-+$/, '');
}

// Everything a deployed scraper needs, taken from the factory's own environment. Values go in as SECRET.
export async function getScraperEnvs(
    scraper: string,
    targetUrl: string,
    env: NodeJS.ProcessEnv = process.env,
): Promise<{ key: string; value: string; scope: string; type: string }[]> {
    let privateKey = env.SNOWFLAKE_PRIVATE_KEY;
    if (!privateKey && env.SNOWFLAKE_PRIVATE_KEY_PATH) {
        const path = env.SNOWFLAKE_PRIVATE_KEY_PATH.replace(/^~(?=\/)/, env.HOME ?? '~');
        privateKey = (await readFile(path, 'utf8')).trim().replaceAll('\n', '\\n');
    }
    const values: Record<string, string | undefined> = {
        SCRAPER_NAME: scraper,
        TARGET_URL: targetUrl,
        POLL_SECONDS: env.SCRAPER_POLL_SECONDS || '30',
        ADMIN_SECRET: env.SCRAPER_ADMIN_SECRET,
        BRIGHTDATA_API_KEY: env.BRIGHTDATA_API_KEY,
        BRIGHTDATA_UNLOCKER_ZONE: env.BRIGHTDATA_UNLOCKER_ZONE,
        SENTRY_DSN: env.SENTRY_DSN,
        SENTRY_ENVIRONMENT: 'production',
        SNOWFLAKE_ACCOUNT: env.SNOWFLAKE_ACCOUNT,
        SNOWFLAKE_USER: env.SNOWFLAKE_USER,
        SNOWFLAKE_PRIVATE_KEY: privateKey,
        SNOWFLAKE_WAREHOUSE: env.SNOWFLAKE_WAREHOUSE,
        SNOWFLAKE_DATABASE: env.SNOWFLAKE_DATABASE,
        SNOWFLAKE_SCHEMA: env.SNOWFLAKE_SCHEMA,
    };
    const envs = Object.entries(values)
        .filter((entry): entry is [string, string] => Boolean(entry[1]))
        .map(([key, value]) => ({ key, value, scope: 'RUN_TIME', type: 'SECRET' }));
    // The commit App Platform built, so the scraper's /version tells the factory a fix is live.
    envs.push({ key: 'SENTRY_RELEASE', value: '${_self.COMMIT_HASH}', scope: 'RUN_TIME', type: 'GENERAL' });
    return envs;
}

export function getScraperSpec(
    scraper: string,
    rel: string,
    repoUrl: string,
    envs: Awaited<ReturnType<typeof getScraperEnvs>>,
): Record<string, unknown> {
    return {
        name: getAppName(scraper),
        region: 'sfo',
        services: [
            {
                name: 'scraper',
                git: { repo_clone_url: repoUrl, branch: 'main' },
                source_dir: rel,
                dockerfile_path: `${rel}/Dockerfile`,
                http_port: 8080,
                instance_count: 1,
                instance_size_slug: 'apps-s-1vcpu-0.5gb',
                health_check: { http_path: '/health' },
                envs,
            },
        ],
    };
}

export async function createApp(token: string, spec: Record<string, unknown>): Promise<App> {
    return (await call<{ app: App }>(token, 'POST', '/apps', { spec })).app;
}

export async function getApp(token: string, appId: string): Promise<App> {
    return (await call<{ app: App }>(token, 'GET', `/apps/${appId}`)).app;
}

export async function triggerDeployment(token: string, appId: string): Promise<string> {
    const { deployment } = await call<{ deployment: Deployment }>(token, 'POST', `/apps/${appId}/deployments`, {
        force_build: true,
    });
    return deployment.id;
}

// Waits until the app's active deployment is `deploymentId` (or any, when not given) and nothing is still
// deploying. Resolves to the app's public URL, or throws on timeout or a failed deployment.
export async function waitForApp(
    token: string,
    appId: string,
    deploymentId?: string,
    onProgress?: (phase: string) => void,
    timeoutMs = 15 * 60_000,
): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastPhase = '';
    while (Date.now() < deadline) {
        const app = await getApp(token, appId);
        const current = app.in_progress_deployment ?? app.pending_deployment;
        const phase = current?.phase ?? app.active_deployment?.phase ?? 'UNKNOWN';
        if (phase !== lastPhase) onProgress?.((lastPhase = phase));
        if (current?.phase === 'ERROR' || current?.phase === 'CANCELED') throw new Error(`deployment ${current.phase}`);
        const active = app.active_deployment;
        const url = app.live_url ?? app.default_ingress;
        if (active && !current && (!deploymentId || active.id === deploymentId) && url) return url;
        await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    throw new Error('the deployment did not finish within 15 minutes');
}
