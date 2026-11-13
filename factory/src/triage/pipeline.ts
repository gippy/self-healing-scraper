import { runFactory } from '../factory/index.ts';
import { pauseScraper, type BreakerResult } from '../feed.ts';
import { explain } from '../gemini.ts';
import { blocksModels, checkText, combineVerdicts, type GuardPart, type GuardResult } from '../guard.ts';
import * as sentry from '../sentry.ts';
import type { Attachment, IssueInfo, LatestEvent, Priority } from '../sentry.ts';
import type { Emit, FactoryInput, FactoryResult, PipelineEvent, Stage } from '../types.ts';
import { askTriage, buildTriageInput, type Triage } from './questions.ts';
import { redact } from './redact.ts';
import { decide } from './route.ts';

// received → evidence → guard → triage (Gemini reads, Gemini Decision 1 judges) → priority_set → source_paused
// → routed → factory | needs_human | done

export type Origin = 'webhook' | 'poll' | 'manual';

export type PipelineDeps = {
    emit: Emit;
    getIssue: (id: string) => Promise<IssueInfo>;
    getLatestEvent: (issueId: string) => Promise<LatestEvent>;
    getAttachment: (projectSlug: string | undefined, eventId: string) => Promise<Attachment | undefined>;
    getRecentLogs: (scraper: string | undefined) => Promise<string>;
    setPriority: (issueId: string, priority: Priority) => Promise<void>;
    addNote: (issueId: string, text: string) => Promise<boolean>;
    pauseScraper: (scraper: string, reason: string, issue: string) => Promise<BreakerResult>;
    guard: (text: string) => Promise<GuardResult>;
    explain: (eventMarkdown: string, recentLogs: string) => Promise<string | undefined>;
    askTriage: (input: string) => Promise<Triage | undefined>;
    runFactory: (input: FactoryInput, emit: Emit) => Promise<FactoryResult>;
};

export function defaultDeps(emit: Emit): PipelineDeps {
    return {
        emit,
        getIssue: sentry.getIssue,
        getLatestEvent: sentry.getLatestEvent,
        getAttachment: sentry.getEventAttachment,
        getRecentLogs: sentry.getRecentLogs,
        setPriority: sentry.setPriority,
        addNote: sentry.addNote,
        pauseScraper,
        guard: (text) => checkText(text),
        explain,
        askTriage,
        runFactory,
    };
}

// What the factory gets: the whole redacted event, cut to a size a prompt can hold.
const FACTORY_EVENT_CHARS = 20_000;
const EXCERPT_CHARS = 1_500;

const running = new Set<string>();

// Starts the pipeline in the background; one run per issue at a time. Returns false if already running.
export function startIssue(issue: IssueInfo | { id: string }, origin: Origin, deps: PipelineDeps): boolean {
    if (running.has(issue.id)) {
        console.log(`[triage] issue ${issue.id} is already running; skipped (${origin})`);
        return false;
    }
    running.add(issue.id);
    runPipeline(issue, origin, deps)
        .catch((error) => console.error(`[triage] issue ${issue.id} crashed:`, error))
        .finally(() => running.delete(issue.id));
    return true;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const kb = (chars: number) => `${(chars / 1024).toFixed(1)} KB`;
const pct = (p: number) => `${Math.round(p * 100)}%`;

type Step = (stage: Stage, status: PipelineEvent['status'], summary: string, data?: unknown) => void;

export async function runPipeline(start: IssueInfo | { id: string }, origin: Origin, deps: PipelineDeps): Promise<void> {
    let issue: IssueInfo = 'shortId' in start ? start : { id: start.id, shortId: start.id, title: `Sentry issue ${start.id}`, permalink: '' };
    let scraper: string | undefined;
    const emit: Step = (stage, status, summary, data) =>
        deps.emit({
            kind: 'heal',
            scraper,
            issueId: issue.id,
            shortId: issue.shortId,
            title: issue.title,
            stage,
            status,
            summary,
            data,
            at: new Date().toISOString(),
        });

    try {
        if (!('shortId' in start)) issue = await deps.getIssue(start.id);
        emit('received', 'done', `New Sentry issue ${issue.shortId} (${origin}).`, {
            origin,
            permalink: issue.permalink,
            level: issue.level,
            culprit: issue.culprit,
            events: issue.count,
            users: issue.userCount,
            firstSeen: issue.firstSeen,
        });
    } catch (error) {
        emit('failed', 'failed', `Could not load issue ${start.id} from Sentry: ${message(error)}`);
        return;
    }

    // Evidence: the latest event, the raw page and the scraper's recent logs, redacted before anything else sees them.
    emit('evidence', 'started', 'Fetching the latest event, the raw page and recent logs from Sentry…');
    let markdown: string;
    let logs: string;
    let attachment: Attachment | undefined;
    let attachmentError: string | undefined;
    try {
        const latest = await deps.getLatestEvent(issue.id);
        // The scraper's name: the `scraper` tag (the older `source` tag as a fallback).
        scraper = latest.tags.scraper || latest.tags.source || undefined;
        const event = redact(latest.markdown);
        markdown = event.text;
        let redactions = event.count;
        try {
            const raw = await deps.getAttachment(issue.projectSlug, latest.eventId);
            if (raw) {
                const cleaned = redact(raw.content);
                attachment = { name: raw.name, content: cleaned.text };
                redactions += cleaned.count;
            }
        } catch (error) {
            attachmentError = message(error);
        }
        const recent = await deps.getRecentLogs(scraper).catch(() => '');
        const cleanedLogs = redact([latest.logs, recent].filter((part) => part?.trim()).join('\n'));
        logs = cleanedLogs.text;
        redactions += cleanedLogs.count;

        const parts = [`Latest event ${latest.eventId.slice(0, 12) || '(no id)'}`];
        parts.push(attachment ? `${attachment.name} attached (${kb(attachment.content.length)})` : 'no raw page attached');
        parts.push(logs ? `${logs.split('\n').length} log lines` : 'no logs');
        if (redactions) parts.push(`${redactions} secret${redactions === 1 ? '' : 's'} redacted`);
        emit('evidence', 'done', `${parts.join(' · ')}.`, {
            eventId: latest.eventId,
            scraper,
            attachment: attachment ? { name: attachment.name, bytes: attachment.content.length } : undefined,
            attachmentError,
            logLines: logs ? logs.split('\n').length : 0,
            redactions,
            excerpt: markdown.slice(0, EXCERPT_CHARS),
        });
    } catch (error) {
        emit('evidence', 'failed', `Could not fetch the event: ${message(error)}`);
        await escalate(issue, deps, emit, scraper, `Could not fetch the evidence from Sentry (${message(error)}).`);
        return;
    }

    // Prompt guard: the event, the raw page and the logs, separately. Nothing reaches a model before this.
    emit('guard', 'started', "Checking the event, the raw page and the logs with Apify's prompt guard…");
    const checks: Array<Promise<GuardPart>> = [deps.guard(markdown).then((r) => ({ ...r, part: 'event' }))];
    if (attachment) checks.push(deps.guard(attachment.content).then((r) => ({ ...r, part: attachment.name })));
    if (logs) checks.push(deps.guard(logs).then((r) => ({ ...r, part: 'logs' })));
    const parts = await Promise.all(checks);
    const verdict = combineVerdicts(parts);
    const worst = parts.find((p) => p.verdict === verdict);
    const what = worst?.part === 'event' ? 'the event text' : worst?.part === 'logs' ? 'the logs' : `the raw page (${worst?.part})`;
    const guardSummary: Record<typeof verdict, string> = {
        clean: 'Prompt guard: clean. Models may read the evidence.',
        examples: 'Prompt guard: contains examples of instructions, but no attack. Models may read it.',
        flagged: `Prompt guard flagged ${what}. No model will read it.`,
        unchecked: `Prompt guard could not check ${what}. No model will read it.`,
    };
    emit('guard', 'done', guardSummary[verdict], { verdict, parts });

    if (blocksModels(verdict)) {
        const decision = decide(verdict, undefined);
        await writePriority(issue, deps, emit, decision.priority, `Prompt guard: ${verdict}. Routed to a human.`);
        await pause(issue, deps, emit, scraper, `${issue.shortId}: the prompt guard ${verdict === 'flagged' ? 'flagged' : 'could not check'} the evidence; a human looks`);
        emit('routed', 'done', decision.reason, { route: decision.route, reason: decision.reason });
        emit('needs_human', 'done', decision.reason, {
            reason: decision.reason,
            findings: parts.flatMap((p) => p.findings.map((f) => ({ ...f, part: p.part }))),
            guardReason: worst?.reason,
        });
        return;
    }

    // Triage: Gemini Flash reads the evidence, Gemini Decision 1 judges it (with Gemini's reading in its input).
    emit('triage', 'started', 'Gemini is reading the event and the logs…');
    const explainStarted = Date.now();
    const explanation = await deps.explain(markdown, logs).catch(() => undefined);
    const explainMs = Date.now() - explainStarted;
    emit('triage', 'started', 'Asking Gemini Decision 1 how severe and how fixable this is…', { explanation, explainMs });
    const triage = await deps.askTriage(buildTriageInput(issue, scraper, explanation, markdown, logs, attachment));
    const decision = decide(verdict, triage, issue.level);
    if (triage) {
        emit(
            'triage',
            'done',
            `Gemini Decision 1: ${decision.severity} (${pct(triage.severity[decision.severity!])}), fixable ${pct(triage.fixable)}.`,
            { explanation, explainMs, severity: triage.severity, fixable: triage.fixable, model: triage.model, ms: triage.ms },
        );
    } else {
        emit('triage', 'failed', 'Gemini Decision 1 did not answer after two attempts.', { explanation, explainMs });
    }

    const note = triage
        ? `Self-heal triage (${triage.model}): benign ${pct(triage.severity.benign)}, minor ${pct(triage.severity.minor)}, ` +
          `critical ${pct(triage.severity.critical)}, fixable ${pct(triage.fixable)}. ${decision.reason}` +
          (explanation ? `\n\nGemini: ${explanation}` : '')
        : `Self-heal triage: ${decision.reason}`;
    await writePriority(issue, deps, emit, decision.priority, note);
    if (decision.route !== 'done') {
        const why = decision.route === 'factory' ? `${issue.shortId} is being fixed` : `${issue.shortId} needs a human`;
        await pause(issue, deps, emit, scraper, why);
    }

    const routeSummary = { done: 'Benign: priority low, the scraper keeps running.', factory: decision.reason, needs_human: decision.reason };
    emit('routed', 'done', routeSummary[decision.route], { route: decision.route, reason: decision.reason });

    if (decision.route === 'needs_human') {
        emit('needs_human', 'done', decision.reason, { reason: decision.reason });
        return;
    }
    if (decision.route !== 'factory' || !triage) return;

    const input: FactoryInput = {
        issue: { id: issue.id, shortId: issue.shortId, title: issue.title, permalink: issue.permalink },
        scraper,
        source: scraper,
        eventMarkdown: markdown.length > FACTORY_EVENT_CHARS ? `${markdown.slice(0, FACTORY_EVENT_CHARS)}\n… [cut]` : markdown,
        attachment,
        triage: { severity: triage.severity, fixable: triage.fixable },
    };
    try {
        const result = await deps.runFactory(input, deps.emit);
        console.log(`[triage] ${issue.shortId}: factory → ${result.outcome}: ${result.reason}`);
    } catch (error) {
        emit('failed', 'failed', `The factory crashed: ${message(error)}`, { error: message(error) });
    }
}

async function writePriority(issue: IssueInfo, deps: PipelineDeps, emit: Step, priority: Priority, note: string): Promise<void> {
    let error: string | undefined;
    try {
        await deps.setPriority(issue.id, priority);
    } catch (e) {
        error = message(e);
    }
    const noteAdded = await deps.addNote(issue.id, note).catch(() => false);
    emit(
        'priority_set',
        error ? 'failed' : 'done',
        error ? `Could not set the Sentry priority to ${priority}: ${error}` : `Sentry priority set to ${priority}.`,
        { priority, noteAdded, error },
    );
}

// Circuit breaker: a non-benign issue pauses the scraper named by the event's `scraper` tag. A failure is shown
// and the pipeline goes on.
async function pause(issue: IssueInfo, deps: PipelineDeps, emit: Step, scraper: string | undefined, reason: string): Promise<void> {
    if (!scraper) {
        emit('source_paused', 'failed', 'The event has no `scraper` tag, so no scraper was paused.', {});
        return;
    }
    const result = await deps.pauseScraper(scraper, reason, issue.shortId).catch(
        (error): BreakerResult => ({ ok: false, error: message(error) }),
    );
    emit(
        'source_paused',
        result.ok ? 'done' : 'failed',
        result.ok ? `Scraper ${scraper} paused: ${reason}.` : `Could not pause scraper ${scraper}: ${result.error}`,
        { scraper, url: result.url, reason, error: result.error },
    );
}

async function escalate(issue: IssueInfo, deps: PipelineDeps, emit: Step, scraper: string | undefined, reason: string): Promise<void> {
    await writePriority(issue, deps, emit, 'high', `Self-heal triage: ${reason} Routed to a human.`);
    if (scraper) await pause(issue, deps, emit, scraper, `${issue.shortId} needs a human`);
    emit('routed', 'done', reason, { route: 'needs_human', reason });
    emit('needs_human', 'done', reason, { reason });
}
