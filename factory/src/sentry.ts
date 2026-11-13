import { z } from 'zod';

import { fakeIssue, fakeLatency, fakeLatestEvent, fakeAttachment, fakeRecentLogs, fakeUnresolvedIssues } from './triage/fakes.ts';

// Sentry's REST API: https://docs.sentry.io/api/. Auth token from an Internal Integration
// (Issue & Event: Read & Write, Project: Read).

export const SENTRY_API = 'https://sentry.io/api/0';
const MAX_ATTACHMENT_BYTES = 2_000_000;

export type IssueInfo = {
    id: string;
    shortId: string;
    title: string;
    permalink: string;
    projectSlug?: string;
    level?: string;
    culprit?: string;
    count?: string;
    userCount?: number;
    firstSeen?: string;
};
// `tags` are the event's tags (`scraper` names the scraper that failed); `logs` are its breadcrumbs, one per line.
export type LatestEvent = { eventId: string; markdown: string; tags: Record<string, string>; logs: string };
export type Attachment = { name: string; content: string };
export type Priority = 'low' | 'medium' | 'high';

const fake = () => process.env.FAKE_EXTERNALS === '1';
const org = () => required('SENTRY_ORG');

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
}

// A new issue can show up in the issue list a few seconds before its event (and attachments) can be read:
// those reads answer 404 until Sentry has stored them. Retry them for up to about half a minute.
async function sentryFetchNew(path: string, attempts = 4, delayMs = 8_000): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await sentryFetch(path);
        } catch (error) {
            if (attempt >= attempts || !String(error).includes('HTTP 404')) throw error;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
}

async function sentryFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${SENTRY_API}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${required('SENTRY_AUTH_TOKEN')}`,
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...init.headers,
        },
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
        throw new Error(`Sentry ${init.method ?? 'GET'} ${path.split('?')[0]} answered HTTP ${response.status}`);
    }
    return response;
}

const issueSchema = z.object({
    id: z.coerce.string(),
    shortId: z.string(),
    title: z.string(),
    permalink: z.string().nullish(),
    web_url: z.string().nullish(),
    project: z.object({ slug: z.string() }).partial().nullish(),
    level: z.string().nullish(),
    culprit: z.string().nullish(),
    count: z.coerce.string().nullish(),
    userCount: z.number().nullish(),
    firstSeen: z.string().nullish(),
});

// Also used for the webhook's `data.issue`.
export function toIssueInfo(raw: unknown): IssueInfo {
    const issue = issueSchema.parse(raw);
    return {
        id: issue.id,
        shortId: issue.shortId,
        title: issue.title,
        permalink: issue.permalink ?? issue.web_url ?? '',
        projectSlug: issue.project?.slug ?? undefined,
        level: issue.level ?? undefined,
        culprit: issue.culprit ?? undefined,
        count: issue.count ?? undefined,
        userCount: issue.userCount ?? undefined,
        firstSeen: issue.firstSeen ?? undefined,
    };
}

export async function getIssue(id: string): Promise<IssueInfo> {
    if (fake()) return fakeIssue(id);
    const response = await sentryFetch(`/organizations/${org()}/issues/${encodeURIComponent(id)}/`);
    return toIssueInfo(await response.json());
}

const eventSchema = z.looseObject({
    eventID: z.string().optional(),
    id: z.string().optional(),
    formatted: z.string().optional(),
    tags: z
        .array(z.object({ key: z.string(), value: z.coerce.string() }))
        .optional()
        .catch(undefined),
});

const tagsOf = (event: z.infer<typeof eventSchema>) => Object.fromEntries((event.tags ?? []).map((t) => [t.key, t.value]));

const breadcrumbsSchema = z.object({
    entries: z
        .array(z.looseObject({ type: z.string(), data: z.unknown() }))
        .optional()
        .catch(undefined),
});
const crumbSchema = z.looseObject({
    timestamp: z.union([z.string(), z.number()]).nullish(),
    level: z.string().nullish(),
    category: z.string().nullish(),
    message: z.string().nullish(),
});

// The event's breadcrumbs (console logs, HTTP calls) as log lines, newest last.
export function breadcrumbsOf(raw: unknown, max = 40): string {
    const entries = breadcrumbsSchema.catch({ entries: undefined }).parse(raw).entries ?? [];
    const crumbs = entries
        .filter((entry) => entry.type === 'breadcrumbs')
        .flatMap((entry) => z.object({ values: z.array(z.unknown()) }).catch({ values: [] }).parse(entry.data).values);
    return crumbs
        .slice(-max)
        .map((value) => crumbSchema.safeParse(value))
        .filter((parsed) => parsed.success && parsed.data.message)
        .map((parsed) => {
            const c = parsed.data!;
            const at = typeof c.timestamp === 'number' ? new Date(c.timestamp * 1000).toISOString() : (c.timestamp ?? '');
            return [at, c.level, c.category, c.message].filter(Boolean).join(' ');
        })
        .join('\n');
}

// The latest event of an issue as markdown (Sentry's llmFormat), plus its event ID for the attachments.
export async function getLatestEvent(issueId: string): Promise<LatestEvent> {
    if (fake()) {
        await fakeLatency(150);
        return fakeLatestEvent(issueId);
    }
    const path = `/organizations/${org()}/issues/${encodeURIComponent(issueId)}/events/latest/`;
    const response = await sentryFetchNew(`${path}?llmFormat=markdown`);
    const body = await response.text();
    let json: unknown;
    try {
        json = JSON.parse(body);
    } catch {
        // Plain markdown: fetch the JSON once more for the event ID.
        const raw = await (await sentryFetch(path)).json();
        const event = eventSchema.parse(raw);
        return { eventId: event.eventID ?? event.id ?? '', markdown: body, tags: tagsOf(event), logs: breadcrumbsOf(raw) };
    }
    const event = eventSchema.parse(json);
    return {
        eventId: event.eventID ?? event.id ?? '',
        markdown: event.formatted ?? eventToMarkdown(json),
        tags: tagsOf(event),
        logs: breadcrumbsOf(json),
    };
}

const attachmentListSchema = z.array(
    z.looseObject({ id: z.coerce.string(), name: z.string(), size: z.number().optional() }),
);

// The raw input the feed's parser failed on: `raw.html` or `raw.json` on the event.
export async function getEventAttachment(projectSlug: string | undefined, eventId: string): Promise<Attachment | undefined> {
    if (fake()) return fakeAttachment(eventId);
    if (!eventId) return undefined;
    const project = projectSlug ?? required('SENTRY_PROJECT');
    const base = `/projects/${org()}/${encodeURIComponent(project)}/events/${encodeURIComponent(eventId)}/attachments/`;
    // Attachments can trail their event by a few seconds: an empty list right after the event is worth a retry.
    let list = attachmentListSchema.parse(await (await sentryFetchNew(base)).json());
    for (let attempt = 1; list.length === 0 && attempt < 4; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 8_000));
        list = attachmentListSchema.parse(await (await sentryFetch(base)).json());
    }
    const chosen =
        list.find((a) => a.name === 'raw.html' || a.name === 'raw.json') ?? list.find((a) => a.name.startsWith('raw.'));
    if (!chosen) return undefined;
    if ((chosen.size ?? 0) > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment ${chosen.name} is larger than 2 MB`);
    // The download may redirect to the storage service; fetch follows it.
    const response = await sentryFetch(`${base}${encodeURIComponent(chosen.id)}/?download=1`);
    return { name: chosen.name, content: await response.text() };
}

// The scraper's recent Sentry logs (last hour, newest last). Best effort: Sentry's logs query API is not in
// its public reference, so any failure returns '' and triage goes on with the event's breadcrumbs.
export async function getRecentLogs(scraper: string | undefined): Promise<string> {
    if (fake()) return fakeRecentLogs(scraper);
    if (!scraper || !process.env.SENTRY_AUTH_TOKEN || !process.env.SENTRY_ORG) return '';
    try {
        const params = new URLSearchParams({
            dataset: 'ourlogs',
            query: `scraper:${scraper}`,
            statsPeriod: '1h',
            sort: '-timestamp',
            per_page: '40',
        });
        for (const field of ['timestamp', 'severity', 'message']) params.append('field', field);
        const response = await sentryFetch(`/organizations/${org()}/events/?${params}`);
        const rows = z.object({ data: z.array(z.record(z.string(), z.unknown())) }).parse(await response.json()).data;
        return rows
            .reverse()
            .map((row) => [row.timestamp, row.severity, row.message].filter((v) => typeof v === 'string' && v).join(' '))
            .filter(Boolean)
            .join('\n');
    } catch (error) {
        console.warn(`[sentry] recent logs unavailable: ${(error as Error).message}`);
        return '';
    }
}

export async function setPriority(issueId: string, priority: Priority): Promise<void> {
    if (fake()) {
        console.log(`[sentry:fake] issue ${issueId} priority → ${priority}`);
        return;
    }
    await sentryFetch(`/organizations/${org()}/issues/${encodeURIComponent(issueId)}/`, {
        method: 'PUT',
        body: JSON.stringify({ priority }),
    });
}

// For the factory after a deploy.
export async function resolveIssue(
    issueId: string,
    status: 'resolvedInNextRelease' | 'resolved' = 'resolvedInNextRelease',
): Promise<void> {
    if (fake()) {
        console.log(`[sentry:fake] issue ${issueId} status → ${status}`);
        return;
    }
    await sentryFetch(`/organizations/${org()}/issues/${encodeURIComponent(issueId)}/`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
    });
}

// Undocumented endpoint; a failure is expected now and then and only logged.
export async function addNote(issueId: string, text: string): Promise<boolean> {
    if (fake()) {
        console.log(`[sentry:fake] note on issue ${issueId}: ${text}`);
        return true;
    }
    try {
        await sentryFetch(`/issues/${encodeURIComponent(issueId)}/comments/`, {
            method: 'POST',
            body: JSON.stringify({ text }),
        });
        return true;
    } catch (error) {
        console.warn(`[sentry] note skipped: ${(error as Error).message}`);
        return false;
    }
}

export async function listUnresolvedIssues(): Promise<IssueInfo[]> {
    if (fake()) return fakeUnresolvedIssues();
    const project = required('SENTRY_PROJECT');
    const response = await sentryFetch(
        `/projects/${org()}/${encodeURIComponent(project)}/issues/?query=${encodeURIComponent('is:unresolved')}`,
    );
    const list = z.array(z.unknown()).parse(await response.json());
    return list.map((raw) => ({ ...toIssueInfo(raw), projectSlug: project }));
}

// Fallback when the API returns JSON without `formatted`: title, exception, in-app frames, tags.
export function eventToMarkdown(raw: unknown): string {
    const event = z
        .looseObject({
            title: z.string().optional(),
            message: z.string().optional(),
            culprit: z.string().nullish(),
            tags: z.array(z.object({ key: z.string(), value: z.coerce.string() })).optional().catch(undefined),
            entries: z.array(z.looseObject({ type: z.string(), data: z.unknown() })).optional().catch(undefined),
        })
        .catch({})
        .parse(raw);
    const lines = [`# ${event.title ?? 'Sentry event'}`];
    if (event.culprit) lines.push('', `Culprit: ${event.culprit}`);
    if (event.message) lines.push('', event.message);
    const frameSchema = z.looseObject({
        filename: z.string().nullish(),
        function: z.string().nullish(),
        lineNo: z.number().nullish(),
        inApp: z.boolean().nullish(),
        context: z.array(z.tuple([z.number(), z.string().nullable()])).nullish().catch(undefined),
    });
    for (const entry of event.entries ?? []) {
        if (entry.type !== 'exception') continue;
        const values = z
            .object({
                values: z.array(
                    z.looseObject({
                        type: z.string().nullish(),
                        value: z.string().nullish(),
                        stacktrace: z.object({ frames: z.array(frameSchema).catch([]) }).nullish().catch(undefined),
                    }),
                ),
            })
            .catch({ values: [] })
            .parse(entry.data).values;
        for (const value of values) {
            lines.push('', `## ${value.type ?? 'Error'}: ${value.value ?? ''}`, '');
            const frames = (value.stacktrace?.frames ?? []).slice(-15).reverse();
            for (const frame of frames) {
                lines.push(`- ${frame.inApp ? '**in app** ' : ''}${frame.filename ?? '?'}:${frame.lineNo ?? '?'} in ${frame.function ?? '?'}`);
                const line = frame.context?.find(([n]) => n === frame.lineNo)?.[1];
                if (frame.inApp && line) lines.push(`  \`${line.trim()}\``);
            }
        }
    }
    if (event.tags?.length) {
        lines.push('', '## Tags', '');
        for (const tag of event.tags) lines.push(`- ${tag.key}: ${tag.value}`);
    }
    return lines.join('\n');
}
