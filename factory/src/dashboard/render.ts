import type { PipelineEvent, Stage } from '../types.ts';

// Server-rendered dashboard: one card per run, rebuilt from its events on every update and pushed over
// SSE as HTML. Each card draws the run as a connected pipeline (lanes of stage nodes, with a branch for a
// stop) and a detail pane per stage. Everything that comes from events is escaped; links must be http(s).

// A node of the pipeline diagram; some nodes cover two stages (deploy started → deployed).
type FlowNode = { key: string; stages: Stage[]; label: string };
const node = (key: Stage, label: string, extra: Stage[] = []): FlowNode => ({ key, stages: [key, ...extra], label });

const MONITOR_NODES: FlowNode[] = [
    node('received', 'Received'),
    node('evidence', 'Evidence'),
    node('guard', 'Prompt guard'),
    node('triage', 'Gemini triage'),
    node('priority_set', 'Priority'),
    node('source_paused', 'Pause scraper'),
    node('routed', 'Route'),
];
const FACTORY_NODES: FlowNode[] = [
    node('worktree', 'Worktree'),
    node('reproduce', 'Failing test'),
    node('fix', 'Fix'),
    node('review', 'Adversarial review'),
    node('gate', 'Gemini gate'),
    node('pr_opened', 'Pull request'),
    node('merged', 'Merged'),
    node('deployed', 'Deploy', ['deploy']),
    node('source_resumed', 'Resume scraper'),
    node('resolved', 'Resolved'),
];
// A create run: the factory builds and deploys a new scraper.
const CREATE_NODES: FlowNode[] = [
    node('investigate', 'Investigate'),
    node('generate', 'Parser + tests'),
    node('verify', 'Verify live'),
    node('gate', 'Gemini gate'),
    node('pr_opened', 'Pull request'),
    node('merged', 'Merged'),
    node('deploy', 'Deploy', ['deployed']),
    node('registered', 'Registered'),
];
const FACTORY_STAGES: Stage[] = FACTORY_NODES.flatMap((n) => n.stages);

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
    review: 'Adversarial review',
    gate: 'Gemini gate',
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
    // Every event of this step: the progress lines of a running agent, then its result.
    log: PipelineEvent[];
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
            open.log.push(event);
            if (event.data !== undefined) open.data = event.data;
        } else {
            rows.push({ stage: event.stage, status: event.status, first: event, last: event, data: event.data, log: [event] });
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

// The factory reports its running model cost as `costUsd`; the highest one seen is the run's total so far.
function costOf(rows: Row[]): number | undefined {
    let cost: number | undefined;
    for (const row of rows) {
        for (const event of row.log) {
            const value = isRecord(event.data) ? event.data.costUsd : undefined;
            if (typeof value === 'number' && Number.isFinite(value) && value > (cost ?? -1)) cost = value;
        }
    }
    return cost;
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

type NodeState = 'pending' | 'active' | 'done' | 'failed' | 'warn' | 'paused' | 'stopped' | 'skipped';
const STATE_LABEL: Record<NodeState, string> = {
    pending: 'waiting',
    active: 'running',
    done: 'done',
    failed: 'failed',
    warn: 'blocked',
    paused: 'paused',
    stopped: 'stopped',
    skipped: 'not run',
};

type Lane = { name: string; nodes: FlowNode[] };
type Ctx = { rows: Row[]; route?: string; finished: boolean; create: boolean; source?: string };

function lanesOf(rows: Row[], create: boolean): Lane[] {
    if (create) return [{ name: 'Create', nodes: CREATE_NODES }];
    return [
        { name: 'Monitor', nodes: MONITOR_NODES },
        { name: 'Factory', nodes: FACTORY_NODES },
    ];
}

function nodeRows(n: FlowNode, rows: Row[]): Row[] {
    return rows.filter((r) => n.stages.includes(r.stage));
}

function nodeState(n: FlowNode, lane: Lane, ctx: Ctx): NodeState {
    const row = ctx.rows.findLast((r) => n.stages.includes(r.stage));
    if (!row) {
        // Steps the run jumped over or will never reach.
        if (ctx.finished) return 'skipped';
        if (!ctx.create && ctx.route && (lane.name === 'Monitor' || ctx.route !== 'factory')) return 'skipped';
        return 'pending';
    }
    if (row.settled === 'stopped') return 'stopped';
    if (row.status === 'started') return 'active';
    if (row.status === 'failed') return 'failed';
    if (n.key === 'source_paused') return 'paused';
    if (n.key === 'guard' && isRecord(row.data) && ['flagged', 'unchecked'].includes(String(row.data.verdict))) return 'warn';
    return 'done';
}

function nodeLabel(n: FlowNode, ctx: Ctx): string {
    if (n.key === 'routed' && ctx.route) return `Route → ${ctx.route === 'done' ? 'close' : ctx.route === 'factory' ? 'factory' : 'human'}`;
    if (n.key === 'source_paused' && ctx.source) return `Pause ${ctx.source}`;
    if (n.key === 'source_resumed' && ctx.source) return `Resume ${ctx.source}`;
    return n.label;
}

// The run stopped (needs_human / failed): which lane node it branched off.
function stopOf(ctx: Ctx, lanes: Lane[]): { row: Row; lane: number; col: number } | undefined {
    const index = ctx.rows.findLastIndex((r) => r.stage === 'needs_human' || r.stage === 'failed');
    if (index < 0) return undefined;
    for (let i = index - 1; i >= 0; i--) {
        for (const [li, lane] of lanes.entries()) {
            const col = lane.nodes.findIndex((n) => n.stages.includes(ctx.rows[i]!.stage));
            if (col >= 0) return { row: ctx.rows[index]!, lane: li, col };
        }
    }
    return { row: ctx.rows[index]!, lane: 0, col: 0 };
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function flow(ctx: Ctx, lanes: Lane[], stop: ReturnType<typeof stopOf>): string {
    let index = 0;
    return `<div class="flow">${lanes
        .map((lane, li) => {
            const count = lane.nodes.length;
            const nodes = lane.nodes
                .map((n) => {
                    index += 1;
                    const state = nodeState(n, lane, ctx);
                    const rows = nodeRows(n, ctx.rows);
                    const first = rows[0];
                    const last = rows.at(-1);
                    const took = first && last && state !== 'active' && last.last !== first.first ? duration(Date.parse(last.last.at) - Date.parse(first.first.at)) : '';
                    const inner = `<span class="n-top"><span class="n-idx">${String(index).padStart(2, '0')}</span><span class="n-state">${STATE_LABEL[state]}</span></span><span class="n-label">${e(nodeLabel(n, ctx))}</span><span class="n-time">${took || ' '}</span>`;
                    return `<li class="node s-${state}">${
                        rows.length ? `<button type="button" class="n-box" data-node="${e(n.key)}">${inner}</button>` : `<div class="n-box">${inner}</div>`
                    }</li>`;
                })
                .join('');
            let branch = '';
            if (stop && stop.lane === li) {
                const human = stop.row.stage === 'needs_human';
                const col = stop.col + 1;
                const start = Math.max(1, Math.min(col, count - 3));
                const span = count - start + 1;
                const at = ((col - start + 0.5) / span) * 100;
                branch = `<li class="branch b-${human ? 'human' : 'failed'}" style="grid-column:${start} / -1;--at:${at.toFixed(2)}%"><button type="button" class="b-box" data-node="stop"><span class="b-title">${
                    human ? '↳ Needs a human' : '↳ Failed'
                }</span><span class="b-why">${e(clip(stop.row.last.summary, 150))}</span></button></li>`;
            }
            return `<div class="lane"><div class="lane-name">${e(lane.name)}</div><ol class="nodes" style="--n:${count}">${nodes}${branch}</ol></div>`;
        })
        .join('')}</div>`;
}

function logLines(row: Row, max: number): string {
    const t0 = Date.parse(row.first.at);
    const lines = row.log.slice(-max);
    return lines
        .map((event) => `<span class="ll"><span class="ll-t">+${duration(Date.parse(event.at) - t0)}</span> ${e(clip(event.summary, 220))}</span>`)
        .join('\n');
}

function pane(key: string, label: string, state: NodeState | 'human', rows: Row[], t0: number, active: boolean): string {
    const last = rows.at(-1)!;
    const offset = Date.parse(rows[0]!.first.at) - t0;
    const took = last.status !== 'started' && last.last !== rows[0]!.first ? Date.parse(last.last.at) - Date.parse(rows[0]!.first.at) : undefined;
    const body = rows
        .map((row) => {
            const progress = row.log.length > 2 && !active ? `<div class="sub-key">agent log</div><pre class="log">${logLines(row, 60)}</pre>` : '';
            return `<p class="summary">${e(row.last.summary)}</p>${details(row)}${progress}`;
        })
        .join('');
    const stateText = state === 'human' ? 'needs a human' : STATE_LABEL[state];
    return `<section class="pane p-${state}" data-pane="${e(key)}" hidden>
<div class="pane-head"><span class="pane-stage">${e(label)}</span><span class="tag s-${state}">${e(stateText)}</span><span class="muted">at +${duration(offset)}</span>${
        took !== undefined ? `<span class="muted">took ${duration(took)}</span>` : ''
    }</div>
${body}
</section>`;
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
        ? `<a class="short-id" href="${e(permalink)}" target="_blank" rel="noopener">${e(last.shortId)} ↗</a>`
        : `<span class="short-id">${e(last.shortId)}</span>`;
    const total = Date.parse(last.at) - t0;
    const create = isCreate(rows);
    const scraper = scraperOf(rows);
    const explanation = explanationOf(rows);
    const cost = costOf(rows);
    const ctx: Ctx = { rows, route: routeOf(rows), finished: outcome.kind !== 'working', create, source: scraper };
    const lanes = lanesOf(rows, create);
    const stop = stopOf(ctx, lanes);

    // One detail pane per node that ran, plus the stop.
    const panes: string[] = [];
    let selected: string | undefined;
    let activeRow: { row: Row; label: string } | undefined;
    for (const lane of lanes) {
        for (const n of lane.nodes) {
            const nr = nodeRows(n, rows);
            if (!nr.length) continue;
            const state = nodeState(n, lane, ctx);
            if (state === 'active') activeRow = { row: nr.at(-1)!, label: nodeLabel(n, ctx) };
            panes.push(pane(n.key, nodeLabel(n, ctx), state, nr, t0, state === 'active'));
            selected = n.key;
        }
    }
    if (stop) {
        panes.push(pane('stop', stop.row.stage === 'needs_human' ? 'Needs a human' : 'Failed', stop.row.stage === 'needs_human' ? 'human' : 'failed', [stop.row], t0, false));
        selected = 'stop';
    }
    const activeKey = activeRow ? lanes.flatMap((l) => l.nodes).find((n) => n.stages.includes(activeRow!.row.stage))?.key : undefined;
    if (activeKey) selected = activeKey;

    const tail = activeRow
        ? `<div class="tail"><div class="tail-head"><span class="tail-dot"></span>${e(activeRow.label)} · live</div><pre class="log">${logLines(activeRow.row, 6)}</pre></div>`
        : '';

    const timeline = rows
        .map((row) => {
            const offset = Date.parse(row.first.at) - t0;
            const tone = row.stage === 'needs_human' ? 'warn' : row.settled === 'stopped' ? 'stopped' : row.status;
            return `<li class="row r-${e(tone)}"><span class="row-time">+${duration(offset)}</span><span class="row-stage">${e(LABEL[row.stage] ?? row.stage)}</span><span class="row-sum">${e(row.last.summary)}</span></li>`;
        })
        .join('');

    return `<article class="card o-${outcome.tone}" id="${domId(last.issueId)}" data-outcome="${e(outcome.kind)}" data-run="${e(first.at)}" data-sel="${e(selected ?? '')}">
<header class="card-head">
  <div class="card-id"><span class="kind k-${create ? 'create' : 'heal'}">${create ? 'New scraper' : 'Heal'}</span>${
      scraper ? `<span class="scraper-name">${e(scraper)}</span>` : ''
  }${create ? '' : shortId}<span class="muted"><time data-t="${e(first.at)}">${e(first.at)}</time> · ${duration(total)}${
      cost !== undefined ? ` · <span class="cost">$${cost.toFixed(2)}</span>` : ''
  }</span></div>
  <h2 class="card-title">${e(last.title)}</h2>
  <div class="card-flags">${badge(outcome.label, outcome.tone)}${create ? '' : scraperBadge(rows)}</div>
</header>
${explanation ? `<blockquote class="explain"><span class="explain-by">Gemini's reading</span>${e(explanation)}</blockquote>` : ''}
${flow(ctx, lanes, stop)}
${tail}
<div class="panes">${panes.join('\n')}</div>
<details class="tl" data-k="timeline"><summary>all ${rows.length} events</summary><ol class="timeline">${timeline}</ol></details>
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
// What the factory itself did to a scraper (from pipeline events): paused for an issue (and healing it), or resumed.
export type PauseHint = { paused: boolean; healing?: boolean; issue?: string; at: string };

const SCRAPER_STATE: Record<string, { label: string; note: string }> = {
    running: { label: 'Running', note: 'breaker closed' },
    paused: { label: 'Paused', note: 'breaker open' },
    healing: { label: 'Healing', note: 'breaker open · factory at work' },
    down: { label: 'Down', note: 'no answer' },
};

export function renderScrapers(scrapers: ScraperRow[], hints: Map<string, PauseHint> = new Map()): string {
    if (!scrapers.length) {
        return `<p class="panel-empty">No scrapers yet. <code>POST /scrapers</code> with a URL and the factory builds one.</p>`;
    }
    return `<ul class="scrapers">${scrapers
        .map((s) => {
            const hint = hints.get(s.name);
            const paused = s.paused ?? hint?.paused ?? false;
            const state = !s.up ? 'down' : paused ? (hint?.healing ? 'healing' : 'paused') : 'running';
            const url = safeUrl(s.url);
            const target = safeUrl(s.targetUrl);
            const lines = [
                paused && hint?.issue ? `<span class="warn-text">paused for ${e(hint.issue)}</span>` : '',
                target ? `<span class="muted">scrapes ${e(target.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</span>` : '',
                url ? `<a href="${e(url)}" target="_blank" rel="noopener">${e(url.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>` : '',
                typeof s.items === 'number' && s.up ? `<span class="muted">${s.items} items</span>` : '',
                s.error ? `<span class="bad-text">${e(s.error)}</span>` : '',
            ].filter(Boolean);
            const info = SCRAPER_STATE[state]!;
            return `<li class="scraper s-${state}"><div class="sc-state"><span class="sc-light"></span><b>${info.label}</b><span class="sc-note">${info.note}</span></div><div class="sc-name">${e(
                s.name,
            )}</div>${lines.map((l) => `<div class="scraper-line">${l}</div>`).join('')}</li>`;
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <div class="brand">
    <div class="brand-kicker">// mission control</div>
    <h1>Self-healing scraper factory</h1>
    <p class="tagline">create → watch in Sentry → prompt guard → Gemini → fix → adversarial review → Gemini gate → deploy</p>
  </div>
  <div class="stats">
    <div class="stat"><b id="n-issues">0</b><span>runs</span></div>
    <div class="stat s-active"><b id="n-working">0</b><span>running</span></div>
    <div class="stat s-done"><b id="n-fixed">0</b><span>shipped</span></div>
    <div class="stat s-warn"><b id="n-human">0</b><span>to a human</span></div>
    <div class="stat clock"><b id="clock">--:--:--</b><span id="live" class="live"><span class="pulse"></span><span class="live-text">live</span></span></div>
    <button type="button" id="theme" class="theme" title="Switch light / dark">◐</button>
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
  const root = document.documentElement;
  const list = document.getElementById('cards');
  const empty = document.getElementById('empty');
  const live = document.getElementById('live');
  const params = new URLSearchParams(location.search);
  let stored = null;
  try { stored = localStorage.getItem('theme'); } catch (_) {}
  const theme = params.get('theme') || stored;
  if (theme) root.dataset.theme = theme;
  document.getElementById('theme').addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('theme', root.dataset.theme); } catch (_) {}
  });
  const clock = document.getElementById('clock');
  const tick = () => { clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); };
  tick(); setInterval(tick, 1000);
  const fmt = (el) => el.querySelectorAll('time[data-t]').forEach((t) => {
    const d = new Date(t.dataset.t);
    if (!isNaN(d)) t.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
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
  // Which stage's details each card shows: the one someone clicked, else the live one the server picked.
  const picked = {};
  const select = (card) => {
    let key = picked[card.id] || card.dataset.sel;
    if (!card.querySelector('.pane[data-pane="' + key + '"]')) key = card.dataset.sel;
    card.querySelectorAll('[data-node]').forEach((b) => b.classList.toggle('sel', b.dataset.node === key));
    card.querySelectorAll('.pane').forEach((p) => { p.hidden = p.dataset.pane !== key; });
  };
  list.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-node]');
    if (!b) return;
    const card = b.closest('.card');
    picked[card.id] = picked[card.id] === b.dataset.node ? undefined : b.dataset.node;
    select(card);
  });
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
      if (old.dataset.run !== card.dataset.run) { picked[card.id] = undefined; old.remove(); list.prepend(card); } else old.replaceWith(card);
    } else {
      list.prepend(card);
    }
    fmt(card);
    select(card);
    if (!replay) { card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 900); }
    counts();
  };
  const connect = () => {
    const es = new EventSource('/events');
    es.addEventListener('card', (ev) => { const d = JSON.parse(ev.data); upsert(d.html, d.replay); });
    es.addEventListener('scrapers', (ev) => { scrapers.innerHTML = JSON.parse(ev.data).html; });
    es.onopen = () => { live.className = 'live on'; live.querySelector('.live-text').textContent = 'live'; };
    es.onerror = () => { live.className = 'live off'; live.querySelector('.live-text').textContent = 'reconnecting'; };
  };
  // The scrapers panel refreshes on its own; a failed refresh keeps the last one.
  const scrapers = document.getElementById('scrapers');
  const refreshScrapers = () => fetch('/scrapers.html').then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
    .then((html) => { scrapers.innerHTML = html; }).catch(() => {});
  setInterval(refreshScrapers, 15000);
  fmt(document);
  list.querySelectorAll('.card').forEach(select);
  counts();
  connect();
})();
`;

const CSS = `
:root {
  --bg: #ecebe6; --panel: #ffffff; --text: #050505; --muted: #575757; --grid: #050505; --hair: #c9c8c1; --soft: #f5f4f0;
  --accent: #2b3bff; --accent-ink: #ffffff; --accent-soft: #e3e5ff;
  --run: #2b3bff; --done: #00873e; --fail: #e0001b; --pause: #c77800; --human: #c77800; --skip: #a3a29b;
  --run-soft: #e3e5ff; --done-soft: #dcf3e4; --fail-soft: #fde0e3; --pause-soft: #fff0d1;
  --c-benign: #8a8a84; --c-minor: #c77800; --c-critical: #e0001b; --c-fixable: #2b3bff; --c-accent: #2b3bff;
  --mono: "JetBrains Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #060708; --panel: #0d0f12; --text: #f3f3f1; --muted: #9a9c9f; --grid: #f3f3f1; --hair: #2a2d32; --soft: #14171b;
  --accent: #5c6cff; --accent-ink: #ffffff; --accent-soft: #171c45;
  --run: #6f7dff; --done: #20d46b; --fail: #ff3347; --pause: #ffb020; --human: #ffb020; --skip: #4a4d52;
  --run-soft: #171c45; --done-soft: #0b2a18; --fail-soft: #33090f; --pause-soft: #2e2105;
  --c-benign: #8d9096; --c-minor: #ffb020; --c-critical: #ff3347; --c-fixable: #6f7dff; --c-accent: #6f7dff;
} }
:root[data-theme="dark"] {
  --bg: #060708; --panel: #0d0f12; --text: #f3f3f1; --muted: #9a9c9f; --grid: #f3f3f1; --hair: #2a2d32; --soft: #14171b;
  --accent: #5c6cff; --accent-ink: #ffffff; --accent-soft: #171c45;
  --run: #6f7dff; --done: #20d46b; --fail: #ff3347; --pause: #ffb020; --human: #ffb020; --skip: #4a4d52;
  --run-soft: #171c45; --done-soft: #0b2a18; --fail-soft: #33090f; --pause-soft: #2e2105;
  --c-benign: #8d9096; --c-minor: #ffb020; --c-critical: #ff3347; --c-fixable: #6f7dff; --c-accent: #6f7dff;
}
* { box-sizing: border-box; border-radius: 0 !important; }
html { font-size: 16px; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--mono); line-height: 1.45; font-variant-ligatures: none;
  background-image: linear-gradient(var(--hair) 1px, transparent 1px), linear-gradient(90deg, var(--hair) 1px, transparent 1px);
  background-size: 32px 32px; background-attachment: fixed; }
button { font: inherit; color: inherit; }
a { color: var(--accent); }
code { font-family: var(--mono); font-size: 0.9em; }
.muted { color: var(--muted); }
.top { display: flex; flex-wrap: wrap; gap: 16px 32px; align-items: stretch; justify-content: space-between; padding: 0 0 0 28px; background: var(--panel); border-bottom: 2px solid var(--grid); position: sticky; top: 0; z-index: 3; }
.brand { padding: 16px 0; }
.brand-kicker { color: var(--accent); font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.14em; }
.brand h1 { margin: 2px 0 0; font-size: 1.75rem; font-weight: 800; letter-spacing: -0.02em; text-transform: uppercase; }
.tagline { margin: 4px 0 0; color: var(--muted); font-size: 0.8rem; }
.stats { display: flex; align-items: stretch; }
.stat { display: flex; flex-direction: column; justify-content: center; align-items: flex-start; min-width: 118px; padding: 10px 18px; border-left: 2px solid var(--grid); }
.stat b { font-size: 2rem; line-height: 1; font-weight: 800; font-variant-numeric: tabular-nums; }
.stat span { font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.12em; margin-top: 6px; }
.stat.s-active b { color: var(--run); } .stat.s-done b { color: var(--done); } .stat.s-warn b { color: var(--human); }
.stat.clock b { font-size: 1.35rem; }
.live { display: flex; align-items: center; gap: 8px; }
.live .pulse { width: 10px; height: 10px; background: var(--skip); }
.live.on .pulse { background: var(--done); animation: blink 1.2s steps(2, start) infinite; }
.live.off .pulse { background: var(--pause); }
.theme { border: 0; border-left: 2px solid var(--grid); background: var(--panel); padding: 0 20px; font-size: 1.4rem; cursor: pointer; }
.theme:hover { background: var(--accent); color: var(--accent-ink); }
@keyframes blink { to { visibility: hidden; } }
.fake { text-align: center; padding: 6px 16px; background: var(--pause); color: #000; font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 2px solid var(--grid); }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 24px; max-width: 1880px; margin: 0 auto; padding: 24px 24px 64px; align-items: start; }
main { min-width: 0; }
.panel { position: sticky; top: 120px; background: var(--panel); border: 2px solid var(--grid); }
.panel h2, .lane-name, .sub-key, .tail-head { font-size: 0.74rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.14em; }
.panel h2 { margin: 0; padding: 10px 14px; background: var(--grid); color: var(--panel); }
.panel-empty { margin: 0; padding: 14px; color: var(--muted); font-size: 0.88rem; }
.scrapers { list-style: none; margin: 0; padding: 0; }
.scraper { padding: 14px; border-top: 2px solid var(--grid); }
.scraper:first-child { border-top: 0; }
.sc-state { display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: var(--done); color: #000; }
.sc-state b { font-size: 1.25rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; }
.sc-note { margin-left: auto; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
.sc-light { width: 14px; height: 14px; background: #000; flex: none; }
.s-running .sc-light { animation: blink 1.6s steps(2, start) infinite; }
.scraper.s-paused .sc-state { background: var(--pause); }
.scraper.s-healing .sc-state { background: var(--run); color: #fff; }
.scraper.s-healing .sc-light { background: #fff; animation: blink 0.6s steps(2, start) infinite; }
.scraper.s-down .sc-state { background: var(--fail); color: #fff; }
.scraper.s-down .sc-light { background: #fff; }
.sc-name { font-size: 1.2rem; font-weight: 800; margin: 10px 0 4px; }
.scraper-line { font-size: 0.8rem; margin-top: 3px; word-break: break-all; }
.bad-text { color: var(--fail); } .warn-text { color: var(--pause); font-weight: 700; }
.empty { text-align: center; padding: 72px 16px; color: var(--muted); background: var(--panel); border: 2px dashed var(--grid); }
.empty-title { font-size: 1.4rem; color: var(--text); margin: 0 0 6px; font-weight: 800; text-transform: uppercase; }
#cards { display: flex; flex-direction: column; gap: 24px; }
.card { background: var(--panel); border: 2px solid var(--grid); border-top-width: 8px; padding: 0 0 4px; transition: box-shadow 0.3s; }
.card.o-good { border-top-color: var(--done); } .card.o-bad { border-top-color: var(--fail); } .card.o-warn { border-top-color: var(--human); }
.card.o-info, .card.o-active { border-top-color: var(--run); } .card.o-muted { border-top-color: var(--skip); }
.card.flash { box-shadow: 6px 6px 0 var(--accent); }
.card-head { display: grid; grid-template-columns: 1fr auto; gap: 4px 16px; align-items: center; padding: 14px 20px 12px; border-bottom: 2px solid var(--grid); }
.card-id { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; font-size: 0.85rem; }
.kind { font-size: 0.74rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; padding: 3px 8px; background: var(--grid); color: var(--panel); }
.kind.k-create { background: var(--accent); color: var(--accent-ink); }
.scraper-name { font-weight: 800; font-size: 0.95rem; }
.short-id { font-weight: 700; text-decoration: none; border-bottom: 2px solid currentColor; }
.cost { color: var(--text); font-weight: 700; }
.card-title { grid-column: 1; margin: 0; font-size: 1.25rem; line-height: 1.3; font-weight: 700; word-break: break-word; }
.card-flags { grid-column: 2; grid-row: 1 / span 2; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.card-flags .badge { font-size: 0.85rem; padding: 6px 12px; }
.badge { display: inline-block; padding: 2px 8px; font-weight: 800; font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.06em; white-space: nowrap; border: 2px solid currentColor; color: var(--muted); }
.badge.t-good { background: var(--done); border-color: var(--done); color: #000; }
.badge.t-bad { background: var(--fail); border-color: var(--fail); color: #fff; }
.badge.t-warn { background: var(--pause); border-color: var(--pause); color: #000; }
.badge.t-info, .badge.t-active { background: var(--run); border-color: var(--run); color: #fff; }
.explain { margin: 0; padding: 12px 20px; border-bottom: 2px solid var(--grid); background: var(--accent-soft); font-size: 0.98rem; line-height: 1.55; }
.explain-by { display: block; font-size: 0.7rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.14em; color: var(--accent); margin-bottom: 4px; }
.explain-by::before { content: '▍'; }
.flow { padding: 14px 20px 6px; display: flex; flex-direction: column; gap: 12px; }
.lane { display: grid; grid-template-columns: 92px minmax(0, 1fr); align-items: start; }
.lane-name { color: var(--muted); padding-top: 22px; }
.lane + .lane .lane-name::before { content: '↳ '; }
.nodes { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); column-gap: 14px; row-gap: 18px; }
.node { position: relative; grid-row: 1; min-width: 0; }
.node + .node::before { content: ''; position: absolute; top: 31px; left: -14px; width: 14px; height: 3px; background: var(--hair); }
.node.s-done + .node::before, .node.s-paused + .node::before, .node.s-warn + .node::before { background: var(--done); }
.n-box { display: flex; flex-direction: column; gap: 3px; width: 100%; height: 100%; min-height: 76px; padding: 7px 8px; text-align: left; background: var(--panel); border: 2px solid var(--hair); color: var(--muted); }
button.n-box, button.b-box { cursor: pointer; }
button.n-box:hover, button.b-box:hover { outline: 2px solid var(--accent); outline-offset: 2px; }
.n-top { display: flex; justify-content: space-between; gap: 4px; font-size: 0.66rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
.n-label { font-size: 0.8rem; font-weight: 700; line-height: 1.2; color: var(--text); overflow-wrap: anywhere; }
.n-time { font-size: 0.68rem; margin-top: auto; }
.s-pending .n-label { color: var(--muted); }
.s-skipped .n-box { border-style: dashed; opacity: 0.45; }
.s-skipped .n-label { color: var(--muted); text-decoration: line-through; }
.s-done .n-box { border-color: var(--done); background: var(--done-soft); }
.s-done .n-state, .s-done .n-time { color: var(--done); }
.s-paused .n-box, .s-warn .n-box { border-color: var(--pause); background: var(--pause); color: #000; }
.s-paused .n-label, .s-warn .n-label { color: #000; }
.s-failed .n-box { border-color: var(--fail); background: var(--fail); color: #fff; }
.s-failed .n-label { color: #fff; }
.s-stopped .n-box { border-color: var(--fail); color: var(--fail); }
.s-active .n-box { border-color: var(--run); background: var(--run); color: #fff; animation: pulse 1.2s ease-in-out infinite; position: relative; overflow: hidden; }
.s-active .n-label { color: #fff; }
.s-active .n-box::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: repeating-linear-gradient(90deg, #fff 0 8px, transparent 8px 16px); animation: march 0.6s linear infinite; }
@keyframes pulse { 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--run) 35%, transparent); } }
@keyframes march { to { background-position: 16px 0; } }
.n-box.sel, .b-box.sel { outline: 3px solid var(--grid); outline-offset: 3px; }
.branch { grid-row: 2; position: relative; min-width: 0; }
.branch::before { content: ''; position: absolute; top: -18px; left: var(--at); width: 3px; height: 18px; background: var(--human); }
.branch.b-failed::before { background: var(--fail); }
.b-box { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 8px 12px; text-align: left; border: 2px solid var(--human); background: var(--pause-soft); }
.b-failed .b-box { border-color: var(--fail); background: var(--fail-soft); }
.b-title { font-size: 0.85rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: var(--human); }
.b-failed .b-title { color: var(--fail); }
.b-why { font-size: 0.82rem; color: var(--text); }
.tail { margin: 6px 20px 4px; border: 2px solid var(--run); background: #050608; color: #d6d9ff; }
.tail-head { display: flex; align-items: center; gap: 8px; padding: 5px 10px; background: var(--run); color: #fff; }
.tail-dot { width: 9px; height: 9px; background: #fff; animation: blink 0.8s steps(2, start) infinite; }
.tail .log { border: 0; background: transparent; color: inherit; max-height: 150px; }
.log { margin: 6px 0 0; padding: 8px 10px; font-family: var(--mono); font-size: 0.78rem; line-height: 1.55; white-space: pre-wrap; word-break: break-word; overflow: auto; max-height: 280px; background: var(--soft); border: 1px solid var(--hair); }
.ll-t { color: var(--muted); }
.tail .ll-t { color: #7f86c9; }
.panes { margin: 10px 20px 8px; }
.pane { border: 2px solid var(--grid); border-left-width: 8px; padding: 12px 16px 14px; }
.pane.p-done { border-left-color: var(--done); } .pane.p-active { border-left-color: var(--run); } .pane.p-failed, .pane.p-stopped { border-left-color: var(--fail); }
.pane.p-paused, .pane.p-warn, .pane.p-human { border-left-color: var(--pause); }
.pane-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; font-size: 0.8rem; margin-bottom: 6px; }
.pane-stage { font-size: 1.05rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; }
.tag { font-size: 0.7rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; padding: 2px 7px; background: var(--skip); color: #000; }
.tag.s-done { background: var(--done); } .tag.s-active { background: var(--run); color: #fff; } .tag.s-failed, .tag.s-stopped { background: var(--fail); color: #fff; }
.tag.s-paused, .tag.s-warn, .tag.s-human { background: var(--pause); }
.summary { margin: 6px 0 0; font-size: 0.92rem; }
.tl { margin: 0 20px 8px; }
.tl > summary { cursor: pointer; list-style: none; font-size: 0.74rem; color: var(--muted); padding: 4px 0; text-transform: uppercase; letter-spacing: 0.1em; }
.tl > summary::-webkit-details-marker { display: none; }
.tl > summary::before { content: '[+] '; }
.tl[open] > summary::before { content: '[-] '; }
.timeline { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--hair); }
.row { display: grid; grid-template-columns: 90px 190px 1fr; gap: 12px; padding: 4px 0; border-bottom: 1px solid var(--hair); font-size: 0.8rem; }
.row-time { color: var(--muted); text-align: right; }
.row-stage { font-weight: 700; }
.r-failed .row-sum { color: var(--fail); } .r-warn .row-sum { color: var(--pause); }
.meta { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 8px; font-size: 0.84rem; color: var(--muted); }
.meta b { color: var(--text); font-weight: 700; }
.meta .yes { color: var(--done); } .meta .no { color: var(--fail); }
.bars { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; max-width: 620px; }
.bar { display: grid; grid-template-columns: 130px 1fr 56px; gap: 10px; align-items: center; font-size: 0.84rem; color: var(--muted); }
.bar.strong { color: var(--text); font-weight: 800; }
.bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.track { position: relative; height: 16px; background: var(--soft); border: 2px solid var(--grid); }
.fill { display: block; height: 100%; transition: width 0.6s ease; }
.fill.c-benign { background: var(--c-benign); } .fill.c-minor { background: var(--c-minor); } .fill.c-critical { background: var(--c-critical); }
.fill.c-fixable { background: var(--c-fixable); } .fill.c-accent { background: var(--c-accent); }
.mark { position: absolute; top: -6px; bottom: -6px; width: 3px; background: var(--text); }
.bar-val { text-align: right; font-variant-numeric: tabular-nums; }
.triage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 8px 32px; }
.sub { margin-top: 8px; }
.sub-key { color: var(--muted); margin-top: 10px; }
.guard { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.guard-part { font-size: 0.88rem; }
.findings { margin: 6px 0 0; padding-left: 20px; font-size: 0.88rem; }
.findings li { margin: 3px 0; word-break: break-word; }
.findings.t-bad li::marker { color: var(--fail); } .findings.t-warn li::marker { color: var(--pause); }
.block { margin-top: 8px; border: 2px solid var(--grid); background: var(--soft); }
.block summary { cursor: pointer; padding: 5px 10px; font-size: 0.76rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.block pre { margin: 0; padding: 10px 12px; max-height: 380px; overflow: auto; font-family: var(--mono); font-size: 0.78rem; line-height: 1.5; white-space: pre; border-top: 2px solid var(--grid); }
.diff .d-add { color: var(--done); background: var(--done-soft); display: inline-block; min-width: 100%; }
.diff .d-del { color: var(--fail); background: var(--fail-soft); display: inline-block; min-width: 100%; }
.diff .d-hunk { color: var(--accent); font-weight: 700; } .diff .d-file { color: var(--muted); font-weight: 800; }
.more { font-size: 0.78rem; color: var(--muted); padding: 4px 12px 8px; }
pre.err { margin: 8px 0 0; padding: 10px 12px; background: var(--fail-soft); color: var(--fail); border: 2px solid var(--fail); font-family: var(--mono); font-size: 0.78rem; white-space: pre-wrap; max-height: 240px; overflow: auto; }
.kv-val { margin: 6px 0 0; }
.link-btn { display: inline-block; margin-top: 10px; margin-right: 8px; padding: 8px 14px; background: var(--accent); color: var(--accent-ink); font-weight: 800; text-decoration: none; font-size: 0.88rem; text-transform: uppercase; letter-spacing: 0.06em; border: 2px solid var(--grid); }
.link-btn:hover { box-shadow: 4px 4px 0 var(--grid); }
@media (max-width: 1280px) {
  .lane { grid-template-columns: 1fr; }
  .lane-name { padding: 0 0 6px; }
  .nodes { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); }
  .node, .branch { grid-row: auto; }
  .node + .node::before, .branch::before { display: none; }
  .branch { grid-column: 1 / -1 !important; }
}
@media (max-width: 1100px) {
  .layout { grid-template-columns: 1fr; }
  .panel { position: static; order: -1; }
}
@media (max-width: 760px) {
  html { font-size: 14px; }
  .top { position: static; padding: 0 0 0 16px; }
  .stat { min-width: 0; padding: 8px 12px; }
  .layout { padding: 16px; }
  .card-head { grid-template-columns: 1fr; }
  .card-flags { grid-column: 1; grid-row: auto; flex-direction: row; flex-wrap: wrap; align-items: flex-start; }
  .row { grid-template-columns: 1fr; gap: 2px; }
  .row-time { text-align: left; }
  .bar { grid-template-columns: 90px 1fr 46px; }
}
`;
