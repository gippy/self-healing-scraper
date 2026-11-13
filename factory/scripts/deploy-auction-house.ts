// Creates (or redeploys) the auction house as a DigitalOcean App Platform app from the public monorepo.
//   node --env-file-if-exists=.env scripts/deploy-auction-house.ts
// Needs DO_API_TOKEN, TIGER_DATABASE_URL and AUCTION_ADMIN_SECRET; RECAPTCHA_* and AUCTION_COOKIE_SECRET are optional.
import { createApp, getApp, triggerDeployment, waitForApp } from '../src/factory/digitalocean.ts';

const token = process.env.DO_API_TOKEN;
if (!token) throw new Error('DO_API_TOKEN is not set');
const repo = process.env.TARGET_REPO || 'gippy/self-healing-scraper';
const existingId = process.env.AUCTION_APP_ID;

const values: Record<string, string | undefined> = {
    TIGER_DATABASE_URL: process.env.TIGER_DATABASE_URL,
    ADMIN_SECRET: process.env.AUCTION_ADMIN_SECRET,
    RECAPTCHA_SITE_KEY: process.env.RECAPTCHA_SITE_KEY,
    RECAPTCHA_SECRET_KEY: process.env.RECAPTCHA_SECRET_KEY,
    COOKIE_SECRET: process.env.AUCTION_COOKIE_SECRET,
};
const envs = Object.entries(values)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => ({ key, value, scope: 'RUN_TIME', type: 'SECRET' }));

let appId: string;
let deploymentId: string | undefined;
if (existingId) {
    appId = (await getApp(token, existingId)).id;
    deploymentId = await triggerDeployment(token, appId);
} else {
    const app = await createApp(token, {
        name: 'auction-house',
        region: 'sfo',
        services: [
            {
                name: 'web',
                git: { repo_clone_url: `https://github.com/${repo}.git`, branch: 'main' },
                source_dir: 'auction-house',
                dockerfile_path: 'auction-house/Dockerfile',
                http_port: 8080,
                instance_count: 1,
                instance_size_slug: 'apps-s-1vcpu-0.5gb',
                health_check: { http_path: '/health' },
                envs,
            },
        ],
    });
    appId = app.id;
    console.log(`Created app ${appId}; set AUCTION_APP_ID=${appId} to redeploy it later.`);
}
const url = await waitForApp(token, appId, deploymentId, (phase) => console.log(`Deployment ${phase}`));
console.log(`The auction house is live at ${url}`);
