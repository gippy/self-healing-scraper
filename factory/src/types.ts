// Shared between triage, dashboard and factory. Owned by nobody: change it only through DESIGN.md.

export type Stage =
    | 'received'
    | 'evidence'
    | 'guard'
    | 'triage'
    | 'priority_set'
    | 'source_paused'
    | 'routed'
    | 'investigate'
    | 'generate'
    | 'verify'
    | 'worktree'
    | 'reproduce'
    | 'fix'
    | 'review'
    | 'gate'
    | 'pr_opened'
    | 'merged'
    | 'deploy'
    | 'deployed'
    | 'registered'
    | 'source_resumed'
    | 'resolved'
    | 'needs_human'
    | 'failed';

export type PipelineEvent = {
    // `create`: the factory building a new scraper; `heal`: fixing one after a Sentry issue (the default).
    kind?: 'create' | 'heal';
    // The scraper this event is about (the Sentry `scraper` tag, or the name given at create).
    scraper?: string;
    // For create runs, a run id; for heal runs, the Sentry issue id.
    issueId: string;
    shortId: string;
    title: string;
    stage: Stage;
    status: 'started' | 'done' | 'failed';
    // One plain sentence for the dashboard.
    summary: string;
    // Stage details: Jev's probabilities, the diff, review findings, the PR URL.
    data?: unknown;
    at: string;
};

export type Severity = 'benign' | 'minor' | 'critical';

export type FactoryInput = {
    issue: { id: string; shortId: string; title: string; permalink: string };
    // The feed source that failed (the event's `source` tag); paused by triage, resumed by the factory.
    source?: string;
    // The scraper that failed (the event's `scraper` tag); its code is in `scrapers/<scraper>/`.
    scraper?: string;
    // The latest event as Sentry's markdown (llmFormat=markdown), redacted and checked by the prompt guard.
    eventMarkdown: string;
    // The raw input the parser failed on (raw.html or raw.json), checked by the prompt guard.
    attachment?: { name: string; content: string };
    triage: { severity: Record<Severity, number>; fixable: number };
};

export type FactoryResult = {
    outcome: 'merged' | 'pr_open' | 'needs_human' | 'failed';
    prUrl?: string;
    reason: string;
};

export type Emit = (event: PipelineEvent) => void;
