import type { GuardVerdict } from '../guard.ts';
import type { Priority } from '../sentry.ts';
import type { Severity } from '../types.ts';

// Routing and priority, exactly as DESIGN.md says:
// - guard flagged/unchecked → high, needs_human (no model sees the text)
// - no Decisions answer → high, needs_human
// - benign → low, done
// - not benign and fixable ≥ 0.6 → factory
// - otherwise → needs_human
// Priority: critical → high, minor → medium, benign → low.

export const FIXABLE_THRESHOLD = 0.6;

export type Route = 'done' | 'factory' | 'needs_human';
export type Decision = { route: Route; priority: Priority; severity?: Severity; reason: string };

const PRIORITY: Record<Severity, Priority> = { benign: 'low', minor: 'medium', critical: 'high' };
// Ties go to the more severe option.
const ORDER: Severity[] = ['critical', 'minor', 'benign'];

export function topSeverity(severity: Record<Severity, number>): Severity {
    let best: Severity = 'critical';
    for (const option of ORDER) if (severity[option] > severity[best]) best = option;
    return best;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

export function decide(guard: GuardVerdict, triage: { severity: Record<Severity, number>; fixable: number } | undefined): Decision {
    if (guard === 'flagged') {
        return { route: 'needs_human', priority: 'high', reason: 'The prompt guard flagged the evidence, so no model may read it.' };
    }
    if (guard === 'unchecked') {
        return { route: 'needs_human', priority: 'high', reason: 'The prompt guard could not check the evidence, so no model may read it.' };
    }
    if (!triage) {
        return { route: 'needs_human', priority: 'high', reason: 'Gemini Decision 1 did not answer; escalating instead of dropping the issue.' };
    }
    const severity = topSeverity(triage.severity);
    const priority = PRIORITY[severity];
    if (severity === 'benign') {
        return { route: 'done', priority, severity, reason: `Gemini Decision 1 rates it benign (${pct(triage.severity.benign)}); nothing to fix.` };
    }
    if (triage.fixable >= FIXABLE_THRESHOLD) {
        return {
            route: 'factory',
            priority,
            severity,
            reason: `${severity} (${pct(triage.severity[severity])}) and fixable (${pct(triage.fixable)} ≥ ${pct(FIXABLE_THRESHOLD)}): sending it to the factory.`,
        };
    }
    return {
        route: 'needs_human',
        priority,
        severity,
        reason: `${severity} (${pct(triage.severity[severity])}) but not fixable in code (${pct(triage.fixable)} < ${pct(FIXABLE_THRESHOLD)}): a human decides.`,
    };
}
