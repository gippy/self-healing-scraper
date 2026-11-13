import type { PipelineEvent, Stage } from '../types.ts';

// Server-rendered dashboard: one card per issue, rebuilt from its events on every update and pushed over
// SSE as HTML. Everything that comes from events is escaped; links must be http(s).

const TRIAGE_STAGES: Stage[] = ['received', 'evidence', 'guard', 'triage', 'priority_set', 'source_paused', 'routed'];
const FACTORY_STAGES: Stage[] = [
    'worktree',
    'reproduce',
    'fix',
    'review',
    'gate',
    'pr_opened',
    'merged',
    'deployed',
    'source_resumed',
    'resolved',
];
// A create run: the factory builds and deploys a new scraper.
const CREATE_STAGES: Stage[] = ['investigate', 'generate', 'verify', 'gate', 'pr_opened', 'merged', 'deploy', 'registered'];

const LABEL: Record<Stage, string> = {
    received: 'Received',
    evidence: 'Evidence',
    guard: 'Prompt guard',
    triage: 'Gemini triage',
    priority_set: 'Priority',
    source_paused: 'Scraper paused',
    routed: 'Routed',
    investigate: 'Investigate',
    generate: 'Parser + tests',
    verify: 'Verify live',
    deploy: 'Deploy',
    registered: 'Registered',
    worktree: 'Worktree',
    reproduce: 'Failing test',
    fix: 'Fix',
    review: 'Review',
    gate: 'Decision gate',
    pr_opened: 'Pull request',
    merged: 'Merged',
    deployed: 'Deployed',
    source_resumed: 'Scraper resumed',
    resolved: 'Resolved',
    needs_human: 'Needs a human',
    failed: 'Failed',
};

export function escapeHtml(value: unknown): string {
    return String(value ?? '').replace(
        /[&<>"']/g,
        (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
    );
}
const e = escapeHtml;

export function safeUrl(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
    } catch {
        return undefined;
    }
}

export function domId(issueId: string): string {
    return `card-${issueId.replace(/[^\w-]/g, '_')}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isProbability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const pct = (p: number) => `${Math.round(p * 100)}%`;

function duration(ms: number): string {
    if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

// ---------- Rows: one per stage run (a `started` and its `done`/`failed` share a row) ----------

type Row = {
    stage: Stage;
    status: PipelineEvent['status'];
    first: PipelineEvent;
    last: PipelineEvent;
    data?: unknown;
    // Set when the status was inferred from later steps rather than reported.
    settled?: 'done' | 'stopped';
};

function buildRows(events: PipelineEvent[]): Row[] {
    const rows: Row[] = [];
    for (const event of events) {
        const open = [...rows].reverse().find((r) => r.stage === event.stage && r.status === 'started');
        if (open) {
            // A later `started` is a progress line for the same step; `done`/`failed` closes it.
            open.status = event.status;
            open.last = event;
            if (event.data !== undefined) open.data = event.data;
        } else {
            rows.push({ stage: event.stage, status: event.status, first: event, last: event, data: event.data });
        }
    }
    return rows;
}

// A step still `started` while later steps followed it has finished; if the run then stopped (needs_human,
// failed) right after it, it was cut short.
function settle(rows: Row[]): Row[] {
    rows.forEach((row, i) => {
        if (row.status !== 'started' || i === rows.length - 1) return;
        const after = rows.slice(i + 1);
        const stopped = after.every((r) => r.stage === 'needs_human' || r.stage === 'failed');
        row.status = stopped ? 'failed' : 'done';
        row.settled = stopped ? 'stopped' : 'done';
    });
    return rows;
}

// The current run only: a rerun starts at the latest `received`.
function currentRun(events: PipelineEvent[]): PipelineEvent[] {
    let start = 0;
    events.forEach((ev, i) => {
        if (ev.stage === 'received') start = i;
    });
    return events.slice(start);
}

type Tone = 'good' | 'bad' | 'warn' | 'info' | 'muted' | 'active';
type Outcome = { kind: string; label: string; tone: Tone };

function routeOf(rows: Row[]): string | undefined {
    const routed = rows.findLast((r) => r.stage === 'routed');
    return isRecord(routed?.data) && typeof routed.data.route === 'string' ? routed.data.route : undefined;
}

function outcomeOf(rows: Row[]): Outcome {
    const terminal = rows.findLast((r) =>
        ['registered', 'resolved', 'deployed', 'merged', 'pr_opened', 'needs_human', 'failed'].includes(r.stage) && r.status !== 'started',
    );
    if (terminal) {
        switch (terminal.stage) {
            case 'registered':
                return { kind: 'registered', label: 'Scraper live', tone: 'good' };
            case 'resolved':
                return { kind: 'resolved', label: 'Fixed · resolved', tone: 'good' };
            case 'deployed':
                return { kind: 'deployed', label: isCreate(rows) ? 'Deployed' : 'Fixed · deployed', tone: 'good' };
            case 'merged':
                return { kind: 'merged', label: rows.at(-1)?.status === 'started' ? 'Merged · deploying…' : 'Merged', tone: 'good' };
            case 'pr_opened':
                if (terminal === rows.at(-1)) return { kind: 'pr_open', label: 'PR open for review', tone: 'info' };
                break;
            case 'needs_human':
                return { kind: 'needs_human', label: 'Needs a human', tone: 'warn' };
            case 'failed':
                return { kind: 'failed', label: 'Failed', tone: 'bad' };
        }
    }
    if (routeOf(rows) === 'done') return { kind: 'benign', label: 'Benign · priority low', tone: 'muted' };
    const last = rows.at(-1);
    return { kind: 'working', label: last ? `${LABEL[last.stage]}…` : 'Working…', tone: 'active' };
}

// ---------- Small pieces ----------

function badge(text: string, tone: Tone): string {
    return `<span class="badge t-${tone}">${e(text)}</span>`;
}

function meta(items: Array<string | undefined | false>): string {
    const shown = items.filter(Boolean);
    return shown.length ? `<div class="meta">${shown.map((i) => `<span>${i}</span>`).join('')}</div>` : '';
}

type Bar = { label: string; value: number; tone?: string; strong?: boolean; mark?: number };

function bars(items: Bar[]): string {
    return `<div class="bars">${items
        .map(
            (b) => `<div class="bar${b.strong ? ' strong' : ''}">
  <span class="bar-label">${e(b.label)}</span>
  <span class="track"><span class="fill c-${e(b.tone ?? 'accent')}" style="width:${(b.value * 100).toFixed(1)}%"></span>${
      b.mark !== undefined ? `<span class="mark" style="left:${(b.mark * 100).toFixed(0)}%" title="threshold ${pct(b.mark)}"></span>` : ''
  }</span>
  <span class="bar-val">${pct(b.value)}</span>
</div>`,
        )
        .join('')}</div>`;
}

function probabilityBars(probabilities: Record<string, number>, legend?: Record<string, unknown>): string {
    const entries = Object.entries(probabilities);
    const top = Math.max(...entries.map(([, p]) => p));
    return bars(
        entries.map(([key, p]) => ({
            label: legend && typeof legend[key] === 'string' ? `${key} · ${legend[key]}` : key,
            value: p,
            tone: TONE_FOR_OPTION[key] ?? 'accent',
            strong: p === top,
        })),
    );
}

const TONE_FOR_OPTION: Record<string, string> = { benign: 'benign', minor: 'minor', critical: 'critical' };

function diffBlock(diff: string, key: string): string {
    const lines = diff.split('\n');
    const shown = lines.slice(0, 400);
    const body = shown
        .map((line) => {
            const cls =
                line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')
                    ? 'd-file'
                    : line.startsWith('@@')
                      ? 'd-hunk'
                      : line.startsWith('+')
                        ? 'd-add'
                        : line.startsWith('-')
                          ? 'd-del'
                          : '';
            return `<span class="${cls}">${e(line) || ' '}</span>`;
        })
        .join('\n');
    const more = lines.length > shown.length ? `<div class="more">… ${lines.length - shown.length} more lines</div>` : '';
    return `<details class="block" data-k="${e(key)}" open><summary>${e(key)}</summary><pre class="diff">${body}</pre>${more}</details>`;
}

function codeBlock(text: string, key: string, open: boolean): string {
    const cut = text.length > 20_000 ? `${text.slice(0, 20_000)}\n… [cut]` : text;
    return `<details class="block" data-k="${e(key)}"${open ? ' open' : ''}><summary>${e(key)}</summary><pre>${e(cut)}</pre></details>`;
}

function looksLikeDiff(text: string): boolean {
    return /^(diff --git|--- |\+\+\+ )/m.test(text) && /^@@ /m.test(text);
}

function findingList(items: unknown[], tone: Tone): string {
    return `<ul class="findings t-${tone}">${items
        .map((item) => {
            if (typeof item === 'string') return `<li>${e(item)}</li>`;
            if (isRecord(item)) {
                const head = item.finding ?? item.detail ?? item.message ?? item.title ?? item.type;
                const rest = Object.entries(item).filter(([k]) => !['finding', 'detail', 'message', 'title'].includes(k) && item[k] !== head);
                return `<li><strong>${e(head ?? '')}</strong>${rest
                    .map(([k, v]) => ` <span class="muted">${e(k)}: ${e(typeof v === 'string' ? v : JSON.stringify(v))}</span>`)
                    .join('')}</li>`;
            }
            return `<li>${e(JSON.stringify(item))}</li>`;
        })
        .join('')}</ul>`;
}

const PROBABILITY_KEYS = /^(noul|fixable|root_?cause|review_?clear|low_?risk|confidence|p|probability)$/i;
// Numbers between 0 and 1 under these keys are not probabilities.
const NOT_PROBABILITY = /score|cost|usd|ms$|count|lines|bytes|seconds|size/i;
// Thresholds drawn as a marker on the bar: the factory's gate (0.8) and triage's fixable (0.6).
const THRESHOLD: Record<string, number> = {
    fixable: 0.6,
    lowRisk: 0.8,
    low_risk: 0.8,
    rootCause: 0.8,
    root_cause: 0.8,
    reviewClear: 0.8,
    review_clear: 0.8,
};
const OPEN_BLOCK_KEYS = /diff|patch|test/i;

// Renders whatever the factory puts in `data`: diffs, review findings, decision answers, PR links, logs.
export function renderData(data: unknown, depth = 0, path = 'data'): string {
    if (data === undefined || data === null) return '';
    if (typeof data === 'string') {
        if (looksLikeDiff(data)) return diffBlock(data, 'diff');
        return data.includes('\n') || data.length > 160 ? codeBlock(data, 'details', false) : `<p class="kv-val">${e(data)}</p>`;
    }
    if (typeof data !== 'object') return `<p class="kv-val">${e(data)}</p>`;
    if (Array.isArray(data)) return data.length ? findingList(data, 'muted') : '';
    if (depth > 3) return codeBlock(JSON.stringify(data, null, 2), path, false);

    const record = data as Record<string, unknown>;
    const answer = renderDecisionAnswer(record);
    if (answer) return answer;
    const entries = Object.entries(record);
    if (entries.length >= 2 && entries.every(([k, v]) => isProbability(v) && !NOT_PROBABILITY.test(k))) {
        return probabilityBars(record as Record<string, number>);
    }

    const out: string[] = [];
    const scalars: string[] = [];
    const probs: Bar[] = [];
    for (const [key, value] of entries) {
        if (value === undefined || value === null || value === '') continue;
        const url = safeUrl(value);
        if (url && (/url$|link|^pr$|href/i.test(key) || typeof value === 'string')) {
            const label = /^pr/i.test(key) ? 'Open pull request ↗' : url.replace(/^https?:\/\//, '');
            out.push(`<a class="link-btn" href="${e(url)}" target="_blank" rel="noopener">${e(label)}</a>`);
        } else if (typeof value === 'string' && (/diff|patch/i.test(key) || looksLikeDiff(value))) {
            out.push(diffBlock(value, key));
        } else if (typeof value === 'string' && /^error$|^stderr$/i.test(key)) {
            out.push(`<pre class="err">${e(value.slice(0, 4_000))}</pre>`);
        } else if (typeof value === 'string' && (value.includes('\n') || value.length > 160)) {
            out.push(codeBlock(value, key, OPEN_BLOCK_KEYS.test(key)));
        } else if (isProbability(value) && (PROBABILITY_KEYS.test(key) || (!Number.isInteger(value) && !NOT_PROBABILITY.test(key)))) {
            probs.push({ label: key, value, tone: 'accent', strong: value >= (THRESHOLD[key] ?? 1), mark: THRESHOLD[key] });
        } else if (typeof value === 'boolean') {
            scalars.push(`${e(key)} ${value ? '<b class="yes">yes</b>' : '<b class="no">no</b>'}`);
        } else if (typeof value === 'string' || typeof value === 'number') {
            scalars.push(`${e(key)} <b>${e(value)}</b>`);
        } else if (Array.isArray(value)) {
            if (!value.length) {
                scalars.push(`${e(key)} <b>none</b>`);
                continue;
            }
            const tone: Tone = /blocking|error|fail/i.test(key) ? 'bad' : /finding/i.test(key) ? 'warn' : 'muted';
            out.push(`<div class="sub"><div class="sub-key">${e(key)}</div>${findingList(value, tone)}</div>`);
        } else if (isRecord(value)) {
            const answer = renderDecisionAnswer(value, key);
            out.push(answer ?? `<div class="sub"><div class="sub-key">${e(key)}</div>${renderData(value, depth + 1, `${path}.${key}`)}</div>`);
        }
    }
    return [scalars.length ? meta(scalars) : '', probs.length ? bars(probs) : '', ...out].join('');
}

// A decision answer object (noul / choice / score) as bars.
function renderDecisionAnswer(value: Record<string, unknown>, key?: string): string | undefined {
    const title = key ? `<div class="sub-key">${e(key)}</div>` : '';
    if (value.type === 'noul' && isProbability(value.noul)) {
        const mark = key ? THRESHOLD[key] : undefined;
        return `<div class="sub">${bars([{ label: key ?? 'yes', value: value.noul, tone: 'accent', mark, strong: mark !== undefined && value.noul >= mark }])}</div>`;
    }
    if ((value.type === 'choice' || value.type === 'score') && isRecord(value.probabilities)) {
        const probabilities = value.probabilities as Record<string, number>;
        const legend = isRecord(value.legend) ? value.legend : undefined;
        const extra = typeof value.score === 'number' ? `<div class="meta"><span>expected score <b>${value.score.toFixed(2)}</b></span></div>` : '';
        return `<div class="sub">${title}${probabilityBars(probabilities, legend)}${extra}</div>`;
    }
    return undefined;
}

// ---------- Stage-specific details for the triage half ----------

function details(row: Row): string {
    const d = isRecord(row.data) ? row.data : undefined;
    switch (row.stage) {
        case 'received': {
            if (!d) return '';
            const first = typeof d.firstSeen === 'string' ? `first seen <time data-t="${e(d.firstSeen)}">${e(d.firstSeen)}</time>` : undefined;
            return meta([
                d.level ? `level <b>${e(d.level)}</b>` : undefined,
                d.events ? `<b>${e(d.events)}</b> events` : undefined,
                d.culprit ? `<code>${e(d.culprit)}</code>` : undefined,
                first,
                d.origin ? `via <b>${e(d.origin)}</b>` : undefined,
            ]);
        }
        case 'evidence': {
            if (!d) return '';
            const attachment = isRecord(d.attachment) ? d.attachment : undefined;
            return (
                meta([
                    attachment ? `📎 <b>${e(attachment.name)}</b> ${e(Math.round(Number(attachment.bytes) / 102.4) / 10)} KB` : 'no attachment',
                    typeof d.redactions === 'number' ? `<b>${d.redactions}</b> redacted` : undefined,
                    typeof d.attachmentError === 'string' ? `<span class="warn-text">attachment: ${e(d.attachmentError)}</span>` : undefined,
                ]) + (typeof d.excerpt === 'string' && d.excerpt ? codeBlock(d.excerpt, 'Event (redacted)', false) : '')
            );
        }
        case 'guard': {
            if (!d || !Array.isArray(d.parts)) return '';
            return `<div class="guard">${d.parts
                .filter(isRecord)
                .map((part) => {
                    const verdict = String(part.verdict);
                    const tone: Tone = verdict === 'clean' ? 'good' : verdict === 'examples' ? 'info' : verdict === 'flagged' ? 'bad' : 'warn';
                    const findings = Array.isArray(part.findings) && part.findings.length ? findingList(part.findings, 'bad') : '';
                    const reason = typeof part.reason === 'string' && verdict === 'unchecked' ? `<span class="muted">${e(part.reason)}</span>` : '';
                    return `<div class="guard-part">${badge(verdict, tone)} <b>${e(part.part)}</b> ${
                        typeof part.ms === 'number' ? `<span class="muted">${duration(part.ms)}</span>` : ''
                    } ${reason}${findings}</div>`;
                })
                .join('')}</div>`;
        }
        case 'triage': {
            const read = d && typeof d.explainMs === 'number' ? `Gemini read it in <b>${duration(d.explainMs)}</b>` : undefined;
            if (!d || !isRecord(d.severity)) return read ? meta([read]) : '';
            const s = d.severity as Record<string, number>;
            const top = Math.max(s.benign ?? 0, s.minor ?? 0, s.critical ?? 0);
            const fixable = Number(d.fixable);
            return (
                `<div class="triage-grid"><div><div class="sub-key">severity</div>${bars(
                    (['benign', 'minor', 'critical'] as const).map((k) => ({ label: k, value: s[k] ?? 0, tone: k, strong: s[k] === top })),
                )}</div><div><div class="sub-key">fixable in code</div>${bars([
                    { label: 'fixable', value: fixable, tone: 'fixable', strong: fixable >= 0.6, mark: 0.6 },
                ])}</div></div>` +
                meta([read, d.model ? `<b>${e(d.model)}</b>` : undefined, typeof d.ms === 'number' ? `answered in <b>${duration(d.ms)}</b>` : undefined])
            );
        }
        case 'priority_set': {
            if (!d) return '';
            const tone: Tone = d.priority === 'high' ? 'bad' : d.priority === 'medium' ? 'warn' : 'muted';
            return meta([
                `${badge(`priority ${String(d.priority)}`, tone)}`,
                d.noteAdded === true ? 'note added to the issue' : d.noteAdded === false ? '<span class="muted">note skipped</span>' : undefined,
            ]);
        }
        case 'source_paused':
        case 'source_resumed': {
            if (!d) return '';
            const name = typeof d.scraper === 'string' ? d.scraper : typeof d.source === 'string' ? d.source : undefined;
            const url = safeUrl(d.url);
            return meta([
                name ? `scraper <b>${e(name)}</b>` : undefined,
                url ? `<a href="${e(url)}" target="_blank" rel="noopener">${e(url.replace(/^https?:\/\//, ''))}</a>` : undefined,
                typeof d.error === 'string' ? `<span class="warn-text">${e(d.error)}</span>` : undefined,
            ]);
        }
        case 'routed': {
            const route = d?.route;
            if (route === 'factory') return meta([badge('→ fix factory', 'info')]);
            if (route === 'needs_human') return meta([badge('→ human', 'warn')]);
            if (route === 'done') return meta([badge('closed: benign', 'muted')]);
            return '';
        }
        case 'needs_human': {
            if (!d) return '';
            const findings = Array.isArray(d.findings) && d.findings.length ? findingList(d.findings, 'bad') : '';
            const rest = Object.fromEntries(Object.entries(d).filter(([k]) => !['reason', 'findings', 'guardReason'].includes(k)));
            return findings + renderData(rest);
        }
        default:
            return renderData(row.data);
    }
}

// ---------- Card ----------

// The scraper this card is about: the events' `scraper`, else what the pause or the evidence recorded.
function scraperOf(rows: Row[]): string | undefined {
    const named = rows.findLast((r) => r.last.scraper)?.last.scraper;
    if (named) return named;
    for (const stage of ['source_paused', 'source_resumed', 'evidence'] as Stage[]) {
        const data = rows.findLast((r) => r.stage === stage)?.data;
        if (!isRecord(data)) continue;
        const name = typeof data.scraper === 'string' ? data.scraper : typeof data.source === 'string' ? data.source : undefined;
        if (name) return name;
    }
    return undefined;
}

const isCreate = (rows: Row[]) => rows.some((r) => r.first.kind === 'create' || r.last.kind === 'create');

// Gemini's plain-language reading of what broke, from the latest event that carries one.
function explanationOf(rows: Row[]): string | undefined {
    for (const row of [...rows].reverse()) {
        if (isRecord(row.data) && typeof row.data.explanation === 'string' && row.data.explanation) return row.data.explanation;
    }
    return undefined;
}

// Circuit-breaker badge for the card header: paused until the factory reports the resume.
function scraperBadge(rows: Row[]): string {
    const source = scraperOf(rows) ?? 'scraper';
    const resumed = rows.findLast((r) => r.stage === 'source_resumed');
    if (resumed?.status === 'done') return badge(`▶ Scraper ${source} resumed`, 'good');
    if (resumed?.status === 'failed') return badge(`Scraper ${source} still paused: resume failed`, 'bad');
    const paused = rows.findLast((r) => r.stage === 'source_paused');
    if (paused?.status === 'done') return badge(`⏸ Scraper ${source} paused`, 'warn');
    if (paused?.status === 'failed') return badge(`Scraper ${source} not paused`, 'bad');
    return '';
}

function rail(rows: Row[]): string {
    const route = routeOf(rows);
    const source = scraperOf(rows);
    const showFactory = route === 'factory' || rows.some((r) => FACTORY_STAGES.includes(r.stage));
    // A benign issue never pauses its scraper.
    const triage = route === 'done' ? TRIAGE_STAGES.filter((s) => s !== 'source_paused') : TRIAGE_STAGES;
    const create = isCreate(rows);
    const stages: Stage[] = create ? [...CREATE_STAGES] : [...triage, ...(showFactory ? FACTORY_STAGES : [])];
    if (rows.some((r) => r.stage === 'needs_human')) stages.push('needs_human');
    if (rows.some((r) => r.stage === 'failed')) stages.push('failed');
    return `<ol class="rail">${stages
        .map((stage) => {
            const row = rows.findLast((r) => r.stage === stage);
            let state = row ? (row.status === 'started' ? 'active' : row.status) : 'pending';
            if (stage === 'needs_human' && row) state = 'warn';
            if (row?.settled === 'stopped') state = 'warn';
            if (stage === 'source_paused' && row?.status === 'done') state = 'warn';
            // Stages the pipeline jumped over (e.g. triage when the guard blocked) once the issue is routed.
            if (!create && !row && route && TRIAGE_STAGES.includes(stage)) state = 'skipped';
            if (stage === 'guard' && isRecord(row?.data) && ['flagged', 'unchecked'].includes(String(row.data.verdict))) state = 'warn';
            let label = LABEL[stage];
            if (stage === 'routed' && route) label = `Routed → ${route === 'done' ? 'done' : route === 'factory' ? 'factory' : 'human'}`;
            if (source && stage === 'source_paused') label = `Scraper ${source} paused`;
            if (source && stage === 'source_resumed') label = `Scraper ${source} resumed`;
            return `<li class="chip s-${state}">${e(label)}</li>`;
        })
        .join('')}</ol>`;
}

export function renderCard(all: PipelineEvent[]): string {
    const events = currentRun(all);
    const first = events[0];
    const last = events.at(-1);
    if (!first || !last) return '';
    const rows = settle(buildRows(events));
    const outcome = outcomeOf(rows);
    const received = rows.find((r) => r.stage === 'received');
    const permalink = isRecord(received?.data) ? safeUrl(received.data.permalink) : undefined;
    const t0 = Date.parse(first.at);
    const shortId = permalink
        ? `<a class="short-id" href="${e(permalink)}" target="_blank" rel="noopener">${e(last.shortId)}</a>`
        : `<span class="short-id">${e(last.shortId)}</span>`;
    const total = Date.parse(last.at) - t0;
    const create = isCreate(rows);
    const scraper = scraperOf(rows);
    const explanation = explanationOf(rows);

    const timeline = rows
        .map((row) => {
            const offset = Date.parse(row.first.at) - t0;
            const took = row.status !== 'started' && row.last !== row.first ? Date.parse(row.last.at) - Date.parse(row.first.at) : undefined;
            const tone = row.stage === 'needs_human' ? 'warn' : row.settled === 'stopped' ? 'stopped' : row.status;
            return `<li class="row r-${e(tone)}">
  <div class="row-time">+${duration(offset)}</div>
  <div class="row-stage"><span class="dot"></span>${e(LABEL[row.stage] ?? row.stage)}${took !== undefined ? `<span class="took">${duration(took)}</span>` : ''}</div>
  <div class="row-body"><p class="summary">${e(row.last.summary)}</p>${details(row)}</div>
</li>`;
        })
        .join('');

    return `<article class="card o-${outcome.tone}" id="${domId(last.issueId)}" data-outcome="${e(outcome.kind)}" data-run="${e(first.at)}">
<header class="card-head">
  <div class="card-id"><span class="kind k-${create ? 'create' : 'heal'}">${create ? 'New scraper' : 'Heal'}</span>${
      scraper ? `<span class="scraper-name">${e(scraper)}</span>` : ''
  }${create ? '' : shortId}<time class="muted" data-t="${e(first.at)}">${e(first.at)}</time><span class="muted">· ${duration(total)}</span></div>
  <h2 class="card-title">${e(last.title)}</h2>
  <div class="card-flags">${badge(outcome.label, outcome.tone)}${create ? '' : scraperBadge(rows)}</div>
</header>
${explanation ? `<blockquote class="explain"><span class="explain-by">Gemini's reading</span>${e(explanation)}</blockquote>` : ''}
${rail(rows)}
<details class="tl" data-k="timeline"${outcome.kind === 'working' ? ' open' : ''}>
<summary>${rows.length} steps</summary>
<ol class="timeline">${timeline}</ol>
</details>
</article>`;
}

// ---------- Scrapers panel ----------

export type ScraperRow = {
    name: string;
    url: string;
    targetUrl?: string;
    up: boolean;
    paused?: boolean;
    items?: number;
    error?: string;
};
// What the factory itself did to a scraper (from pipeline events): paused for an issue, or resumed.
export type PauseHint = { paused: boolean; issue?: string; at: string };

export function renderScrapers(scrapers: ScraperRow[], hints: Map<string, PauseHint> = new Map()): string {
    if (!scrapers.length) {
        return `<p class="panel-empty">No scrapers yet. <code>POST /scrapers</code> with a URL and the factory builds one.</p>`;
    }
    return `<ul class="scrapers">${scrapers
        .map((s) => {
            const hint = hints.get(s.name);
            const paused = s.paused ?? hint?.paused ?? false;
            const state = !s.up ? 'down' : paused ? 'paused' : 'running';
            const tone: Tone = state === 'running' ? 'good' : state === 'paused' ? 'warn' : 'bad';
            const url = safeUrl(s.url);
            const target = safeUrl(s.targetUrl);
            const lines = [
                url ? `<a href="${e(url)}" target="_blank" rel="noopener">${e(url.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>` : '',
                target ? `<span class="muted">scrapes ${e(target.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</span>` : '',
                paused && hint?.issue ? `<span class="warn-text">paused for ${e(hint.issue)}</span>` : '',
                typeof s.items === 'number' && s.up ? `<span class="muted">${s.items} items</span>` : '',
                s.error ? `<span class="bad-text">${e(s.error)}</span>` : '',
            ].filter(Boolean);
            return `<li class="scraper s-${state}"><div class="scraper-head"><span class="dot"></span><b>${e(s.name)}</b>${badge(state, tone)}</div>${lines
                .map((l) => `<div class="scraper-line">${l}</div>`)
                .join('')}</li>`;
        })
        .join('')}</ul>`;
}

// ---------- Page ----------

export function renderPage(options: { cards: string[]; fake: boolean; scrapers?: string }): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scraper factory</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <div class="brand">
    <h1>Self-healing scraper factory</h1>
    <p class="tagline">Creates scrapers, watches them in Sentry, and heals them when a site changes: prompt guard → Gemini → Gemini Decision 1 → fix → gate → deploy</p>
  </div>
  <div class="stats">
    <div class="stat"><b id="n-issues">0</b><span>runs</span></div>
    <div class="stat"><b id="n-working">0</b><span>in progress</span></div>
    <div class="stat good"><b id="n-fixed">0</b><span>shipped</span></div>
    <div class="stat warn"><b id="n-human">0</b><span>to a human</span></div>
    <div id="live" class="live"><span class="pulse"></span><span class="live-text">live</span></div>
  </div>
</header>
${options.fake ? '<div class="fake">FAKE_EXTERNALS=1 · Sentry, prompt guard, Gemini and the scraper pause are canned</div>' : ''}
<div class="layout">
<main>
  <div id="empty" class="empty"${options.cards.length ? ' hidden' : ''}>
    <p class="empty-title">Waiting for work…</p>
    <p>Ask the factory for a new scraper, or switch the auction house to another layout and watch a scraper break and heal.</p>
  </div>
  <section id="cards">${options.cards.join('\n')}</section>
</main>
<aside class="panel">
  <h2>Scrapers</h2>
  <div id="scrapers">${options.scrapers ?? ''}</div>
</aside>
</div>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

const CLIENT_JS = `
(() => {
  const list = document.getElementById('cards');
  const empty = document.getElementById('empty');
  const live = document.getElementById('live');
  const params = new URLSearchParams(location.search);
  if (params.get('theme')) document.documentElement.dataset.theme = params.get('theme');
  const fmt = (root) => root.querySelectorAll('time[data-t]').forEach((t) => {
    const d = new Date(t.dataset.t);
    if (!isNaN(d)) t.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  });
  const set = (id, n) => { document.getElementById(id).textContent = n; };
  const counts = () => {
    const cards = [...list.children];
    const by = (kinds) => cards.filter((c) => kinds.includes(c.dataset.outcome)).length;
    set('n-issues', cards.length);
    set('n-working', by(['working']));
    set('n-fixed', by(['merged', 'deployed', 'resolved', 'registered']));
    set('n-human', by(['needs_human', 'pr_open', 'failed']));
    empty.hidden = cards.length > 0;
  };
  const upsert = (html, replay) => {
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    const card = tpl.content.firstElementChild;
    if (!card) return;
    const old = document.getElementById(card.id);
    if (old) {
      const open = {};
      old.querySelectorAll('details[data-k]').forEach((d) => { open[d.dataset.k] = d.open; });
      card.querySelectorAll('details[data-k]').forEach((d) => { if (d.dataset.k in open) d.open = open[d.dataset.k]; });
      if (old.dataset.run !== card.dataset.run) { old.remove(); list.prepend(card); } else old.replaceWith(card);
    } else {
      list.prepend(card);
    }
    fmt(card);
    openNewest();
    if (!replay) { card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1200); }
    counts();
  };
  const connect = () => {
    const es = new EventSource('/events');
    es.addEventListener('card', (ev) => { const d = JSON.parse(ev.data); upsert(d.html, d.replay); });
    es.addEventListener('scrapers', (ev) => { scrapers.innerHTML = JSON.parse(ev.data).html; });
    es.onopen = () => { live.className = 'live on'; live.querySelector('.live-text').textContent = 'live'; };
    es.onerror = () => { live.className = 'live off'; live.querySelector('.live-text').textContent = 'reconnecting'; };
  };
  // The newest card always shows its timeline unless someone closed it.
  const openNewest = () => {
    const tl = list.firstElementChild && list.firstElementChild.querySelector('details.tl');
    if (tl && !tl.dataset.closed) tl.open = true;
  };
  list.addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (d.classList && d.classList.contains('tl') && !d.open) d.dataset.closed = '1';
  }, true);
  // The scrapers panel refreshes on its own; a failed refresh keeps the last one.
  const scrapers = document.getElementById('scrapers');
  const refreshScrapers = () => fetch('/scrapers.html').then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
    .then((html) => { scrapers.innerHTML = html; }).catch(() => {});
  setInterval(refreshScrapers, 15000);
  fmt(document);
  openNewest();
  counts();
  connect();
})();
`;

const CSS = `
:root {
  --bg: #f3f4f6; --card: #ffffff; --text: #111418; --muted: #5b6370; --line: #e2e5ea; --soft: #f6f7f9;
  --good: #137333; --good-bg: #e6f4ea; --bad: #c5221f; --bad-bg: #fce8e6; --warn: #9a5b00; --warn-bg: #fef3e0;
  --info: #1a56db; --info-bg: #e8effd; --on-info: #ffffff; --accent: #6d28d9; --accent-bg: #f1eafe; --active: #1a56db;
  --c-benign: #7b8794; --c-minor: #e09b14; --c-critical: #d93025; --c-fixable: #1a56db; --c-accent: #6d28d9;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0e1116; --card: #161b22; --text: #e8ebf0; --muted: #98a2b0; --line: #2a313c; --soft: #1c222b;
  --good: #3fb950; --good-bg: #12261a; --bad: #ff6b61; --bad-bg: #2e1513; --warn: #e5a33a; --warn-bg: #2b2011;
  --info: #6ea8fe; --info-bg: #142139; --on-info: #0b1220; --accent: #b794f6; --accent-bg: #241a38; --active: #6ea8fe;
  --c-benign: #8b96a5; --c-minor: #e5a33a; --c-critical: #ff6b61; --c-fixable: #6ea8fe; --c-accent: #b794f6;
} }
:root[data-theme="dark"] {
  --bg: #0e1116; --card: #161b22; --text: #e8ebf0; --muted: #98a2b0; --line: #2a313c; --soft: #1c222b;
  --good: #3fb950; --good-bg: #12261a; --bad: #ff6b61; --bad-bg: #2e1513; --warn: #e5a33a; --warn-bg: #2b2011;
  --info: #6ea8fe; --info-bg: #142139; --on-info: #0b1220; --accent: #b794f6; --accent-bg: #241a38; --active: #6ea8fe;
  --c-benign: #8b96a5; --c-minor: #e5a33a; --c-critical: #ff6b61; --c-fixable: #6ea8fe; --c-accent: #b794f6;
}
* { box-sizing: border-box; }
html { font-size: 17px; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.45; }
a { color: var(--info); }
code { font-family: var(--mono); font-size: 0.85em; }
.muted { color: var(--muted); }
.top { display: flex; flex-wrap: wrap; gap: 16px 32px; align-items: center; justify-content: space-between; padding: 22px 32px; background: var(--card); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 2; }
.brand h1 { margin: 0; font-size: 1.7rem; letter-spacing: -0.01em; }
.tagline { margin: 2px 0 0; color: var(--muted); font-size: 0.92rem; }
.stats { display: flex; gap: 22px; align-items: center; }
.stat { display: flex; flex-direction: column; align-items: center; min-width: 64px; }
.stat b { font-size: 1.6rem; line-height: 1.1; font-variant-numeric: tabular-nums; }
.stat span { font-size: 0.78rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.stat.good b { color: var(--good); } .stat.warn b { color: var(--warn); }
.live { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; background: var(--soft); font-size: 0.85rem; color: var(--muted); }
.live .pulse { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); }
.live.on .pulse { background: var(--good); box-shadow: 0 0 0 0 var(--good); animation: ping 2s infinite; }
.live.off .pulse { background: var(--warn); }
@keyframes ping { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--good) 60%, transparent); } 100% { box-shadow: 0 0 0 10px transparent; } }
.fake { text-align: center; padding: 6px 16px; background: var(--warn-bg); color: var(--warn); font-size: 0.85rem; font-weight: 600; }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 24px; max-width: 1640px; margin: 0 auto; padding: 24px 24px 64px; align-items: start; }
main { min-width: 0; }
.panel { position: sticky; top: 112px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; }
.panel h2 { margin: 0 0 10px; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.panel-empty { margin: 0; color: var(--muted); font-size: 0.92rem; }
.scrapers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.scraper { padding: 10px 12px; border-radius: 10px; background: var(--soft); border-left: 4px solid var(--good); }
.scraper.s-paused { border-left-color: var(--warn); } .scraper.s-down { border-left-color: var(--bad); }
.scraper-head { display: flex; align-items: center; gap: 8px; font-size: 1.02rem; }
.scraper-head .badge { margin-left: auto; }
.scraper .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--good); flex: none; }
.scraper.s-paused .dot { background: var(--warn); } .scraper.s-down .dot { background: var(--bad); }
.scraper-line { font-size: 0.82rem; margin-top: 3px; word-break: break-all; }
.bad-text { color: var(--bad); }
.kind { font-size: 0.72rem; font-weight: 750; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 8px; border-radius: 5px; background: var(--info-bg); color: var(--info); }
.kind.k-create { background: var(--accent-bg); color: var(--accent); }
.scraper-name { font-family: var(--mono); font-weight: 700; font-size: 0.9rem; }
.explain { margin: 12px 0 2px; padding: 12px 16px; border-left: 4px solid var(--accent); background: var(--accent-bg); border-radius: 0 10px 10px 0; font-size: 1.02rem; line-height: 1.5; }
.explain-by { display: block; font-size: 0.72rem; font-weight: 750; text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent); margin-bottom: 4px; }
.empty { text-align: center; padding: 72px 16px; color: var(--muted); }
.empty-title { font-size: 1.4rem; color: var(--text); margin: 0 0 6px; }
#cards { display: flex; flex-direction: column; gap: 22px; }
.card { background: var(--card); border: 1px solid var(--line); border-left: 6px solid var(--line); border-radius: 14px; padding: 18px 24px 10px; box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04); transition: box-shadow 0.4s; }
.card.o-good { border-left-color: var(--good); } .card.o-bad { border-left-color: var(--bad); } .card.o-warn { border-left-color: var(--warn); }
.card.o-info, .card.o-active { border-left-color: var(--info); } .card.o-muted { border-left-color: var(--c-benign); }
.card.flash { box-shadow: 0 0 0 3px color-mix(in srgb, var(--info) 35%, transparent); }
.card-head { display: grid; grid-template-columns: 1fr auto; gap: 2px 16px; align-items: center; }
.card-id { display: flex; gap: 10px; align-items: baseline; font-size: 0.9rem; }
.short-id { font-family: var(--mono); font-weight: 700; font-size: 0.95rem; text-decoration: none; }
.card-title { grid-column: 1; margin: 0; font-size: 1.3rem; line-height: 1.3; word-break: break-word; }
.card-flags { grid-column: 2; grid-row: 1 / span 2; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.card-flags .badge { font-size: 0.95rem; padding: 6px 14px; }
.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-weight: 650; font-size: 0.82rem; white-space: nowrap; background: var(--soft); color: var(--muted); }
.badge.t-good { background: var(--good-bg); color: var(--good); } .badge.t-bad { background: var(--bad-bg); color: var(--bad); }
.badge.t-warn { background: var(--warn-bg); color: var(--warn); } .badge.t-info, .badge.t-active { background: var(--info-bg); color: var(--info); }
.rail { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; padding: 0; margin: 14px 0 10px; }
.chip { font-size: 0.78rem; font-weight: 600; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--line); color: var(--muted); background: var(--card); }
.chip.s-done { background: var(--good-bg); border-color: transparent; color: var(--good); }
.chip.s-failed { background: var(--bad-bg); border-color: transparent; color: var(--bad); }
.chip.s-warn { background: var(--warn-bg); border-color: transparent; color: var(--warn); }
.chip.s-skipped { text-decoration: line-through; opacity: 0.55; }
.chip.s-active { background: var(--info-bg); border-color: var(--info); color: var(--info); animation: breathe 1.4s ease-in-out infinite; }
@keyframes breathe { 50% { opacity: 0.55; } }
.tl > summary { cursor: pointer; list-style: none; font-size: 0.8rem; color: var(--muted); padding: 2px 0 8px; }
.tl > summary::-webkit-details-marker { display: none; }
.tl > summary::before { content: '▸ show '; }
.tl[open] > summary::before { content: '▾ hide '; }
.timeline { list-style: none; padding: 0; margin: 0; }
.row { display: grid; grid-template-columns: 76px 170px 1fr; gap: 14px; padding: 12px 0; border-top: 1px solid var(--line); }
.row-time { font-family: var(--mono); font-size: 0.8rem; color: var(--muted); padding-top: 3px; text-align: right; }
.row-stage { font-weight: 650; font-size: 0.95rem; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.row-stage .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--good); flex: none; transform: translateY(-1px); }
.r-stopped .dot { background: var(--muted); }
.r-started .dot { background: var(--active); animation: breathe 1.4s infinite; } .r-failed .dot { background: var(--bad); } .r-warn .dot { background: var(--warn); }
.took { font-weight: 400; font-size: 0.78rem; color: var(--muted); font-family: var(--mono); }
.row-body { min-width: 0; }
.summary { margin: 0; }
.r-failed .summary { color: var(--bad); } .r-warn .summary { color: var(--warn); font-weight: 600; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 6px; font-size: 0.86rem; color: var(--muted); }
.meta b { color: var(--text); font-weight: 650; }
.meta .yes { color: var(--good); } .meta .no { color: var(--bad); }
.warn-text { color: var(--warn); }
.bars { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; max-width: 560px; }
.bar { display: grid; grid-template-columns: 120px 1fr 52px; gap: 10px; align-items: center; font-size: 0.88rem; color: var(--muted); }
.bar.strong { color: var(--text); font-weight: 700; }
.bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.track { position: relative; height: 14px; background: var(--soft); border-radius: 7px; overflow: visible; border: 1px solid var(--line); }
.fill { display: block; height: 100%; border-radius: 7px; transition: width 0.6s ease; }
.fill.c-benign { background: var(--c-benign); } .fill.c-minor { background: var(--c-minor); } .fill.c-critical { background: var(--c-critical); }
.fill.c-fixable { background: var(--c-fixable); } .fill.c-accent { background: var(--c-accent); }
.mark { position: absolute; top: -4px; bottom: -4px; width: 2px; background: var(--text); opacity: 0.7; }
.bar-val { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--mono); }
.triage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 8px 32px; }
.sub { margin-top: 8px; }
.sub-key { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 700; margin-top: 6px; }
.guard { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.guard-part { font-size: 0.9rem; }
.findings { margin: 6px 0 0; padding-left: 20px; font-size: 0.9rem; }
.findings li { margin: 3px 0; word-break: break-word; }
.findings.t-bad li::marker { color: var(--bad); } .findings.t-warn li::marker { color: var(--warn); }
.block { margin-top: 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--soft); }
.block summary { cursor: pointer; padding: 6px 12px; font-size: 0.82rem; font-weight: 650; color: var(--muted); }
.block pre { margin: 0; padding: 10px 12px; max-height: 360px; overflow: auto; font-family: var(--mono); font-size: 0.8rem; line-height: 1.5; white-space: pre; border-top: 1px solid var(--line); }
.diff .d-add { color: var(--good); background: var(--good-bg); display: inline-block; min-width: 100%; }
.diff .d-del { color: var(--bad); background: var(--bad-bg); display: inline-block; min-width: 100%; }
.diff .d-hunk { color: var(--info); } .diff .d-file { color: var(--muted); font-weight: 700; }
.more { font-size: 0.8rem; color: var(--muted); padding: 4px 12px 8px; }
pre.err { margin: 8px 0 0; padding: 10px 12px; border-radius: 8px; background: var(--bad-bg); color: var(--bad); font-family: var(--mono); font-size: 0.8rem; white-space: pre-wrap; max-height: 240px; overflow: auto; }
.kv-val { margin: 6px 0 0; }
.link-btn { display: inline-block; margin-top: 8px; margin-right: 8px; padding: 6px 14px; border-radius: 8px; background: var(--info); color: var(--on-info); font-weight: 650; text-decoration: none; font-size: 0.9rem; }
@media (max-width: 1100px) {
  .layout { grid-template-columns: 1fr; }
  .panel { position: static; order: -1; }
}
@media (max-width: 760px) {
  html { font-size: 15px; }
  .top { padding: 14px 16px; position: static; }
  .layout { padding: 16px; }
  .row { grid-template-columns: 1fr; gap: 4px; }
  .row-time { text-align: left; }
  .card-head { grid-template-columns: 1fr; }
  .card-flags { grid-column: 1; grid-row: auto; flex-direction: row; flex-wrap: wrap; align-items: flex-start; }
  .bar { grid-template-columns: 90px 1fr 46px; }
}
`;
