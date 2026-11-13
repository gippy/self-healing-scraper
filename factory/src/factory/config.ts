import { resolve } from 'node:path';

// DigitalOcean Serverless Inference serves Claude through an Anthropic Messages-compatible endpoint, paid
// from DigitalOcean credits. Claude Code takes it through ANTHROPIC_BASE_URL with a model access key.
export const DIGITALOCEAN_INFERENCE_URL = 'https://inference.do-ai.run';

export type FactoryConfig = {
    // `owner/name` on GitHub, or a local path to clone from (tests and local runs).
    targetRepo: string;
    githubToken?: string;
    // The key the agents use: a DigitalOcean model access key, or an Anthropic API key.
    anthropicApiKey?: string;
    // Set for DigitalOcean; unset means api.anthropic.com.
    anthropicBaseUrl?: string;
    // DigitalOcean's id for the small model Claude Code uses for side tasks.
    smallModel?: string;
    // Gemini Decision 1, the factory's gates.
    geminiApiKey?: string;
    // DigitalOcean API token for App Platform deploys.
    doApiToken?: string;
    fixerModel: string;
    reviewerModel: string;
    // The feed's public URL; the factory polls `GET /version` there to see a merge deployed.
    feedUrl?: string;
    workDir: string;
    // `FACTORY_SHIP=0` stops after the gate: no push, no PR, no merge. For local runs.
    ship: boolean;
    // Spend cap for each agent run, in USD.
    maxAgentUsd: number;
};

export function getFactoryConfig(env: NodeJS.ProcessEnv = process.env): FactoryConfig {
    // A DigitalOcean model access key wins over an Anthropic key.
    const digitalOcean = Boolean(env.DO_MODEL_ACCESS_KEY);
    return {
        targetRepo: env.TARGET_REPO || 'gippy/self-healing-scraper',
        githubToken: env.GITHUB_TOKEN || undefined,
        anthropicApiKey: env.DO_MODEL_ACCESS_KEY || env.ANTHROPIC_API_KEY || undefined,
        anthropicBaseUrl: digitalOcean ? DIGITALOCEAN_INFERENCE_URL : undefined,
        // On DigitalOcean, Claude and GPT need a higher account tier than a new account has (403), while the
        // open-weight models work. The fixer and the reviewer come from different labs on purpose: a
        // reviewer that doesn't share the fixer's training is better at finding what it missed.
        smallModel: digitalOcean ? env.SMALL_MODEL || 'minimax-m3.1-flash' : undefined,
        geminiApiKey: env.GEMINI_API_KEY || env.GEMINI_ACCESS_KEY || undefined,
        doApiToken: env.DO_API_TOKEN || undefined,
        fixerModel: env.FIXER_MODEL || (digitalOcean ? 'kimi-k3.1-pro' : 'claude-sonnet-5-5'),
        reviewerModel: env.REVIEWER_MODEL || (digitalOcean ? 'glm-5.3' : 'claude-opus-5-5'),
        feedUrl: env.FEED_URL || undefined,
        workDir: resolve(env.FACTORY_WORK_DIR || 'work'),
        ship: env.FACTORY_SHIP !== '0',
        maxAgentUsd: Number(env.FACTORY_MAX_AGENT_USD || 3),
    };
}
