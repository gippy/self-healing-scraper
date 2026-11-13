import { z } from 'zod';

import { fakeGuardResponse, fakeLatency } from './triage/fakes.ts';

// Apify's prompt guard. `flagged` or `unchecked` means no model sees the text.

export const GUARD_URL = 'https://prompt-guard.apify.actor/?tier=thorough';
// Longer texts are not sent: what the factory would get beyond the limit would be unchecked.
export const GUARD_MAX_CHARS = 100_000;

export type GuardVerdict = 'clean' | 'examples' | 'flagged' | 'unchecked';
export type GuardFinding = { type: string; detail: string };
export type GuardResult = { verdict: GuardVerdict; findings: GuardFinding[]; reason?: string; ms: number };
export type GuardPart = GuardResult & { part: string };

const responseSchema = z.object({
    verdict: z.object({
        flagged: z.boolean(),
        label: z.enum(['clean', 'examples', 'flagged']),
    }),
    findings: z
        .array(z.object({ type: z.string().catch('finding'), detail: z.string().catch('') }))
        .optional()
        .catch(undefined),
});

// Maps the guard's JSON to a verdict. Malformed answers are `unchecked`; `flagged: true` always wins.
export function mapGuardResponse(json: unknown): { verdict: GuardVerdict; findings: GuardFinding[]; reason?: string } {
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) return { verdict: 'unchecked', findings: [], reason: 'The prompt guard sent a malformed answer.' };
    const { verdict, findings = [] } = parsed.data;
    const label: GuardVerdict = verdict.flagged || verdict.label === 'flagged' ? 'flagged' : verdict.label;
    return { verdict: label, findings: findings.map((f) => ({ type: f.type, detail: f.detail.slice(0, 500) })) };
}

export function blocksModels(verdict: GuardVerdict): boolean {
    return verdict === 'flagged' || verdict === 'unchecked';
}

const SEVERITY: Record<GuardVerdict, number> = { clean: 0, examples: 1, unchecked: 2, flagged: 3 };

// The worst verdict across parts (the event text and the attachment are checked separately).
export function combineVerdicts(parts: GuardPart[]): GuardVerdict {
    let worst: GuardVerdict = 'clean';
    for (const part of parts) if (SEVERITY[part.verdict] > SEVERITY[worst]) worst = part.verdict;
    return worst;
}

export async function checkText(text: string, options: { attempts?: number; timeoutMs?: number } = {}): Promise<GuardResult> {
    const { attempts = 2, timeoutMs = 30_000 } = options;
    const started = Date.now();
    const done = (result: Omit<GuardResult, 'ms'>): GuardResult => ({ ...result, ms: Date.now() - started });

    if (!text.trim()) return done({ verdict: 'clean', findings: [], reason: 'Empty text.' });
    if (text.length > GUARD_MAX_CHARS) {
        return done({ verdict: 'unchecked', findings: [], reason: `Text is longer than ${GUARD_MAX_CHARS} characters.` });
    }

    if (process.env.FAKE_EXTERNALS === '1') {
        await fakeLatency(500);
        return done(mapGuardResponse(fakeGuardResponse(text)));
    }

    const token = process.env.APIFY_TOKEN;
    if (!token) return done({ verdict: 'unchecked', findings: [], reason: 'APIFY_TOKEN is not set.' });
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain; charset=utf-8' };
    if (process.env.PROMPT_GUARD_INTERNAL_KEY) headers['X-Apify-Internal-Key'] = process.env.PROMPT_GUARD_INTERNAL_KEY;

    let reason = 'The prompt guard did not answer.';
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const response = await fetch(GUARD_URL, {
                method: 'POST',
                headers,
                body: text,
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!response.ok) {
                reason = `The prompt guard answered HTTP ${response.status}.`;
                // A 4xx won't change on retry.
                if (response.status < 500) break;
                continue;
            }
            return done(mapGuardResponse(await response.json()));
        } catch (error) {
            reason = `The prompt guard failed: ${(error as Error).message}.`;
            console.warn(`[guard] attempt ${attempt}/${attempts} failed: ${(error as Error).message}`);
        }
    }
    return done({ verdict: 'unchecked', findings: [], reason });
}
