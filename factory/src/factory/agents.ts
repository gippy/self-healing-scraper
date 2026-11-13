import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { type CanUseTool, query } from '@anthropic-ai/claude-agent-sdk';

// What an agent may do, enforced here in code. Reads stay inside the workspace; writes only under
// `writable` prefixes; Bash only runs `commands` exactly or with arguments, and never chains commands.
export type ToolPolicy = { writable: string[]; commands: string[] };

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
// Characters that would let one allowed command run another.
const SHELL_CONTROL = /[;&|`$<>\n\\]/;

function getToolPath(input: Record<string, unknown>): string | undefined {
    const path = input.file_path ?? input.path ?? input.notebook_path;
    return typeof path === 'string' ? path : undefined;
}

function getRelativePath(cwd: string, path: string): string | undefined {
    const rel = relative(cwd, isAbsolute(path) ? path : resolve(cwd, path));
    return rel.startsWith('..') || isAbsolute(rel) ? undefined : rel;
}

export function createToolGuard(cwd: string, policy: ToolPolicy): CanUseTool {
    return async (toolName, input) => {
        const deny = (message: string) => ({ behavior: 'deny' as const, message });
        if (READ_TOOLS.has(toolName)) {
            const path = getToolPath(input);
            if (path !== undefined && getRelativePath(cwd, path) === undefined) return deny('Stay inside the repository.');
            return { behavior: 'allow', updatedInput: input };
        }
        if (WRITE_TOOLS.has(toolName)) {
            const path = getToolPath(input);
            const rel = path === undefined ? undefined : getRelativePath(cwd, path);
            if (rel === undefined || !policy.writable.some((prefix) => rel.startsWith(prefix))) {
                return deny(`In this step you may only write under: ${policy.writable.join(', ') || 'nothing'}.`);
            }
            return { behavior: 'allow', updatedInput: input };
        }
        if (toolName === 'Bash') {
            const command = typeof input.command === 'string' ? input.command.trim() : '';
            const allowed =
                !SHELL_CONTROL.test(command) &&
                policy.commands.some((prefix) => command === prefix || command.startsWith(`${prefix} `));
            if (!allowed) return deny(`Only these commands are allowed: ${policy.commands.join(', ')}.`);
            return { behavior: 'allow', updatedInput: input };
        }
        return deny(`${toolName} is not available here.`);
    };
}

export type AgentRun<T> = { ok: boolean; output?: T; text: string; costUsd: number; error?: string };

export type AgentOptions = {
    cwd: string;
    model: string;
    apiKey: string;
    // DigitalOcean's Anthropic-compatible endpoint, when the factory runs on DigitalOcean inference.
    baseUrl?: string;
    smallModel?: string;
    // An empty home, so the agent never reads the host's Claude settings, memory or credentials.
    homeDir: string;
    systemPrompt: string;
    prompt: string;
    tools: string[];
    policy: ToolPolicy;
    // JSON schema for a structured answer.
    schema?: Record<string, unknown>;
    maxTurns: number;
    maxBudgetUsd: number;
    // Called with a short line for each tool call, for the dashboard.
    onStep?: (line: string) => void;
};

function describeToolUse(name: string, input: Record<string, unknown>, cwd: string): string {
    const path = getToolPath(input);
    if (path) return `${name} ${getRelativePath(cwd, path) ?? path}`;
    if (typeof input.command === 'string') return `${name}: ${input.command.slice(0, 80)}`;
    if (typeof input.pattern === 'string') return `${name} ${input.pattern.slice(0, 80)}`;
    return name;
}

export async function runAgent<T>(options: AgentOptions): Promise<AgentRun<T>> {
    await mkdir(options.homeDir, { recursive: true });
    let text = '';
    try {
        const messages = query({
            prompt: options.prompt,
            options: {
                cwd: options.cwd,
                model: options.model,
                systemPrompt: options.systemPrompt,
                tools: options.tools,
                permissionMode: 'default',
                canUseTool: createToolGuard(options.cwd, options.policy),
                settingSources: [],
                persistSession: false,
                env: {
                    PATH: process.env.PATH,
                    HOME: options.homeDir,
                    ANTHROPIC_API_KEY: options.apiKey,
                    CLAUDE_AGENT_SDK_CLIENT_APP: 'selfheal-factory/0.1',
                    ...(options.baseUrl
                        ? {
                              ANTHROPIC_BASE_URL: options.baseUrl,
                              // DigitalOcean's setup for Claude Code: beta headers fail authorization there,
                              // and nothing else should go to Anthropic.
                              CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
                              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
                              ...(options.smallModel
                                  ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: options.smallModel, ANTHROPIC_SMALL_FAST_MODEL: options.smallModel }
                                  : {}),
                          }
                        : {}),
                },
                maxTurns: options.maxTurns,
                maxBudgetUsd: options.maxBudgetUsd,
                ...(options.schema ? { outputFormat: { type: 'json_schema' as const, schema: options.schema } } : {}),
            },
        });
        for await (const message of messages) {
            if (message.type === 'assistant') {
                for (const block of message.message.content) {
                    if (block.type === 'tool_use') {
                        options.onStep?.(describeToolUse(block.name, block.input as Record<string, unknown>, options.cwd));
                    } else if (block.type === 'text') {
                        text = block.text;
                    }
                }
            } else if (message.type === 'result') {
                // An API error (a 403 from the provider, for example) arrives as a "success" with is_error set.
                const isError = 'is_error' in message && message.is_error === true;
                if (message.subtype === 'success' && !isError) {
                    return {
                        ok: true,
                        output: message.structured_output as T | undefined,
                        text: message.result || text,
                        costUsd: message.total_cost_usd,
                    };
                }
                const detail = message.subtype === 'success' ? message.result : message.subtype;
                return { ok: false, text, costUsd: message.total_cost_usd, error: detail.slice(0, 300) };
            }
        }
        return { ok: false, text, costUsd: 0, error: 'the agent ended without a result' };
    } catch (error) {
        return { ok: false, text, costUsd: 0, error: String(error).slice(0, 500) };
    }
}

export function getAgentHome(workDir: string, name: string): string {
    return join(workDir, 'agent-home', name);
}
