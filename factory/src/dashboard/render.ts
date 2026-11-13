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
    node('review', 'Review'),
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
const MARK: Record<NodeState, string> = { pending: '', active: '●', done: '✓', failed: '✕', warn: '!', paused: '⏸', stopped: '✕', skipped: '' };

type Lane = { name: string; nodes: FlowNode[] };
type Ctx = { rows: Row[]; route?: string; finished: boolean; create: boolean; source?: string };

function lanesOf(create: boolean): Lane[] {
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
    return `<div class="flow">${lanes
        .map((lane, li) => {
            const count = lane.nodes.length;
            const nodes = lane.nodes
                .map((n) => {
                    const state = nodeState(n, lane, ctx);
                    const rows = nodeRows(n, ctx.rows);
                    const inner = `<span class="n-mark">${MARK[state]}</span><span class="n-label">${e(nodeLabel(n, ctx))}</span>`;
                    return `<li class="node s-${state}">${
                        rows.length ? `<button type="button" class="n-box" data-node="${e(n.key)}" title="${e(STATE_LABEL[state])}">${inner}</button>` : `<div class="n-box">${inner}</div>`
                    }</li>`;
                })
                .join('');
            let branch = '';
            if (stop && stop.lane === li) {
                const human = stop.row.stage === 'needs_human';
                const col = stop.col + 1;
                const start = Math.max(1, Math.min(col, count - 2));
                const span = count - start + 1;
                const at = ((col - start + 0.5) / span) * 100;
                branch = `<li class="branch b-${human ? 'human' : 'failed'}" style="grid-column:${start} / -1;--at:${at.toFixed(2)}%"><button type="button" class="b-box" data-node="stop">${
                    human ? '↳ Needs a human' : '↳ Failed'
                }</button></li>`;
            }
            return `<div class="lane"><div class="lane-name">${e(lane.name)}</div><ol class="nodes" style="--n:${count}">${nodes}${branch}</ol></div>`;
        })
        .join('')}</div>`;
}

function logLines(row: Row, max: number): string {
    const t0 = Date.parse(row.first.at);
    return row.log
        .slice(-max)
        .map((event) => `<span class="ll"><span class="ll-t">+${duration(Date.parse(event.at) - t0)}</span> ${e(clip(event.summary, 220))}</span>`)
        .join('\n');
}

function pane(key: string, label: string, state: NodeState | 'human', rows: Row[], t0: number): string {
    const last = rows.at(-1)!;
    const offset = Date.parse(rows[0]!.first.at) - t0;
    const took = last.status !== 'started' && last.last !== rows[0]!.first ? Date.parse(last.last.at) - Date.parse(rows[0]!.first.at) : undefined;
    const body = rows
        .map((row) => {
            const progress = row.log.length > 2 ? `<div class="sub-key">agent log</div><pre class="log">${logLines(row, 60)}</pre>` : '';
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

function linkOf(rows: Row[], key: 'prUrl' | 'url'): string | undefined {
    for (const row of [...rows].reverse()) {
        for (const event of [...row.log].reverse()) {
            const url = isRecord(event.data) ? safeUrl(event.data[key]) : undefined;
            if (url) return url;
        }
    }
    return undefined;
}

// The one line under the pipeline: what the focused step did, plus at most one compact visual.
function headline(ctx: Ctx, focus: { row: Row; key: string } | undefined): string {
    if (!focus) return '';
    const { row, key } = focus;
    const d = isRecord(row.data) ? row.data : undefined;
    let text = row.status === 'started' ? row.first.summary : row.last.summary;
    let visual = '';
    if (key === 'stop') {
        text = `${row.stage === 'needs_human' ? 'Needs a human' : 'Failed'}: ${row.last.summary}`;
    } else if (row.stage === 'triage' && row.status === 'done' && d && isRecord(d.severity)) {
        const s = d.severity as Record<string, number>;
        const top = (['critical', 'minor', 'benign'] as const).reduce((a, b) => ((s[b] ?? 0) > (s[a] ?? 0) ? b : a));
        const fixable = Number(d.fixable);
        text = `Gemini: ${top} ${pct(s[top] ?? 0)}, fixable ${pct(fixable)}`;
        visual = bars([
            { label: top, value: s[top] ?? 0, tone: top, strong: true },
            { label: 'fixable', value: fixable, tone: 'fixable', strong: fixable >= 0.6, mark: 0.6 },
        ]);
    } else if (row.stage === 'gate' && d && isRecord(d.answers)) {
        const answers = Object.entries(d.answers).filter((entry): entry is [string, number] => isProbability(entry[1]) && !NOT_PROBABILITY.test(entry[0]));
        if (answers.length) visual = bars(answers.map(([k, v]) => ({ label: k, value: v, tone: 'accent', strong: v >= (THRESHOLD[k] ?? 1), mark: THRESHOLD[k] })));
    } else if (row.stage === 'source_paused' && row.status === 'done') {
        text = `Scraper ${ctx.source ?? ''} paused: no bad data reaches Snowflake`.replace('  ', ' ');
    } else if (row.stage === 'source_resumed' && row.status === 'done') {
        text = `Scraper ${ctx.source ?? ''} resumed: data flows again`.replace('  ', ' ');
    }
    if (['pr_opened', 'merged', 'deploy', 'deployed', 'source_resumed', 'resolved', 'registered'].includes(row.stage) || key === 'stop') {
        const pr = linkOf(ctx.rows, 'prUrl');
        const live = row.stage === 'registered' ? linkOf(ctx.rows, 'url') : undefined;
        visual = [pr ? `<a class="link-btn" href="${e(pr)}" target="_blank" rel="noopener">Open pull request ↗</a>` : '', live ? `<a class="link-btn" href="${e(live)}" target="_blank" rel="noopener">Open scraper ↗</a>` : '']
            .filter(Boolean)
            .join('');
    }
    return `<div class="now"><p class="now-text">${e(clip(text, 160))}</p>${visual ? `<div class="now-visual">${visual}</div>` : ''}</div>`;
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
    const create = isCreate(rows);
    const scraper = scraperOf(rows);
    const explanation = explanationOf(rows);
    const cost = costOf(rows);
    const ctx: Ctx = { rows, route: routeOf(rows), finished: outcome.kind !== 'working', create, source: scraper };
    const lanes = lanesOf(create);
    const stop = stopOf(ctx, lanes);

    const panes: string[] = [];
    let focus: { row: Row; key: string } | undefined;
    let active: { row: Row; key: string; label: string } | undefined;
    for (const lane of lanes) {
        for (const n of lane.nodes) {
            const nr = nodeRows(n, rows);
            if (!nr.length) continue;
            const state = nodeState(n, lane, ctx);
            if (state === 'active') active = { row: nr.at(-1)!, key: n.key, label: nodeLabel(n, ctx) };
            panes.push(pane(n.key, nodeLabel(n, ctx), state, nr, t0));
            if (!focus || Date.parse(nr.at(-1)!.last.at) >= Date.parse(focus.row.last.at)) focus = { row: nr.at(-1)!, key: n.key };
        }
    }
    if (stop) {
        panes.push(pane('stop', stop.row.stage === 'needs_human' ? 'Needs a human' : 'Failed', stop.row.stage === 'needs_human' ? 'human' : 'failed', [stop.row], t0));
        focus = { row: stop.row, key: 'stop' };
    }
    if (active) focus = { row: active.row, key: active.key };

    const tail = active
        ? `<div class="tail"><div class="tail-head"><span class="tail-dot"></span>${e(active.label)} · live</div><pre class="log">${logLines(active.row, 8)}</pre></div>`
        : '';
    const timeline = rows
        .map((row) => {
            const offset = Date.parse(row.first.at) - t0;
            const tone = row.stage === 'needs_human' ? 'warn' : row.settled === 'stopped' ? 'stopped' : row.status;
            return `<li class="row r-${e(tone)}"><span class="row-time">+${duration(offset)}</span><span class="row-stage">${e(LABEL[row.stage] ?? row.stage)}</span><span class="row-sum">${e(row.last.summary)}</span></li>`;
        })
        .join('');
    const kind = create ? 'New scraper' : 'Heal';
    const id = create ? '' : permalink ? `<a class="short-id" href="${e(permalink)}" target="_blank" rel="noopener">${e(last.shortId)} ↗</a>` : `<span class="short-id">${e(last.shortId)}</span>`;

    return `<article class="card o-${outcome.tone}" id="${domId(last.issueId)}" data-outcome="${e(outcome.kind)}" data-run="${e(first.at)}" data-sel="${e(focus?.key ?? '')}">
<button type="button" class="card-line"><span class="kind k-${create ? 'create' : 'heal'}">${kind}</span><span class="line-scraper">${e(scraper ?? '')}</span><span class="line-title">${e(last.title)}</span>${badge(outcome.label, outcome.tone)}${create ? '' : scraperBadge(rows)}</button>
<header class="card-head">
  <div class="kicker"><span class="kind k-${create ? 'create' : 'heal'}">${kind}</span>${scraper ? `<span class="scraper-name">${e(scraper)}</span>` : ''}${id}</div>
  <h2 class="card-title">${e(last.title)}</h2>
  <div class="card-flags">${badge(outcome.label, outcome.tone)}</div>
</header>
${flow(ctx, lanes, stop)}
${headline(ctx, focus)}
<details class="extra" data-k="more"><summary>details</summary>
${explanation ? `<blockquote class="explain"><span class="explain-by">Gemini's reading</span>${e(explanation)}</blockquote>` : ''}
${tail}
<div class="panes">${panes.join('\n')}</div>
<div class="meta"><span><time data-t="${e(first.at)}">${e(first.at)}</time></span><span>took <b>${duration(Date.parse(last.at) - t0)}</b></span>${
        cost !== undefined ? `<span>model cost <span class="cost">$${cost.toFixed(2)}</span></span>` : ''
    }</div>
<ol class="timeline">${timeline}</ol>
</details>
</article>`;
}

// ---------- Scrapers strip ----------

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

export function renderScrapers(scrapers: ScraperRow[], hints: Map<string, PauseHint> = new Map()): string {
    if (!scrapers.length) return `<p class="panel-empty">No scrapers yet</p>`;
    return `<ul class="scrapers">${scrapers
        .map((s) => {
            const hint = hints.get(s.name);
            const paused = s.paused ?? hint?.paused ?? false;
            const state = !s.up ? 'down' : paused ? (hint?.healing ? 'healing' : 'paused') : 'running';
            const why = paused && hint?.issue ? `paused for ${hint.issue}` : !s.up && s.error ? s.error : typeof s.items === 'number' ? `${s.items} items` : '';
            return `<li class="scraper s-${state}" title="${e(why)}"><span class="sc-name">${e(s.name)}</span><b class="sc-state"><span class="sc-light"></span>${state}</b></li>`;
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
  <h1>Self-healing scraper factory</h1>
  <div class="stats">
    <div class="stat s-done"><b id="n-fixed">0</b><span>shipped</span></div>
    <div class="stat s-warn"><b id="n-human">0</b><span>to a human</span></div>
    <span id="live" class="live" title="live"><span class="pulse"></span></span>
    <button type="button" id="theme" class="theme" title="Switch light / dark">◐</button>
  </div>
</header>
<div id="scrapers" class="strip">${options.scrapers ?? ''}</div>
${options.fake ? '<div class="fake">FAKE_EXTERNALS=1 · canned Sentry, guard and Gemini</div>' : ''}
<main>
  <div id="empty" class="empty"${options.cards.length ? ' hidden' : ''}>
    <p class="empty-title">Waiting for work…</p>
  </div>
  <section id="cards">${options.cards.join('\n')}</section>
</main>
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
  const fmt = (el) => el.querySelectorAll('time[data-t]').forEach((t) => {
    const d = new Date(t.dataset.t);
    if (!isNaN(d)) t.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  });
  const set = (id, n) => { document.getElementById(id).textContent = n; };
  const counts = () => {
    const cards = [...list.children];
    const by = (kinds) => cards.filter((c) => kinds.includes(c.dataset.outcome)).length;
    set('n-fixed', by(['merged', 'deployed', 'resolved', 'registered']));
    set('n-human', by(['needs_human', 'pr_open', 'failed']));
    empty.hidden = cards.length > 0;
  };
  // Which stage's details each card shows: the one someone clicked, else the one the server picked.
  const picked = {};
  const select = (card) => {
    let key = picked[card.id] || card.dataset.sel;
    if (!card.querySelector('.pane[data-pane="' + key + '"]')) key = card.dataset.sel;
    card.querySelectorAll('[data-node]').forEach((b) => b.classList.toggle('sel', !!picked[card.id] && b.dataset.node === key));
    card.querySelectorAll('.pane').forEach((p) => { p.hidden = p.dataset.pane !== key; });
  };
  list.addEventListener('click', (ev) => {
    const line = ev.target.closest('.card-line');
    if (line) { line.closest('.card').classList.toggle('open'); return; }
    const b = ev.target.closest('[data-node]');
    if (!b) return;
    const card = b.closest('.card');
    picked[card.id] = picked[card.id] === b.dataset.node ? undefined : b.dataset.node;
    const more = card.querySelector('details.extra');
    if (more) more.open = !!picked[card.id];
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
      if (old.classList.contains('open')) card.classList.add('open');
      if (old.dataset.run !== card.dataset.run) { picked[card.id] = undefined; old.remove(); list.prepend(card); } else old.replaceWith(card);
    } else {
      list.prepend(card);
    }
    fmt(card);
    select(card);
    counts();
  };
  const connect = () => {
    const es = new EventSource('/events');
    es.addEventListener('card', (ev) => { const d = JSON.parse(ev.data); upsert(d.html, d.replay); });
    es.addEventListener('scrapers', (ev) => { scrapers.innerHTML = JSON.parse(ev.data).html; });
    es.onopen = () => { live.className = 'live on'; };
    es.onerror = () => { live.className = 'live off'; };
  };
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

const DARK = `
  --bg: #07080a; --panel: #0c0e11; --text: #f2f2f0; --muted: #8b8f96; --dim: #3a3e45; --hair: #23262b; --soft: #13161a;
  --accent: #6f7dff; --accent-ink: #ffffff; --accent-soft: #151a3d;
  --done: #2fd27a; --fail: #ff4053; --pause: #ffb020;
  --done-soft: #0b2416; --fail-soft: #2e0a10; --pause-soft: #2a1e06;
  --c-benign: #8b8f96; --c-minor: #ffb020; --c-critical: #ff4053; --c-fixable: #6f7dff; --c-accent: #6f7dff;`;

const CSS = `
:root {
  --bg: #f1f0ec; --panel: #ffffff; --text: #060606; --muted: #62625e; --dim: #c4c3bd; --hair: #dddcd6; --soft: #f6f5f2;
  --accent: #2b3bff; --accent-ink: #ffffff; --accent-soft: #e6e8ff;
  --done: #00843c; --fail: #db0019; --pause: #b86e00;
  --done-soft: #dff2e6; --fail-soft: #fde2e5; --pause-soft: #fff1d6;
  --c-benign: #8a8a84; --c-minor: #b86e00; --c-critical: #db0019; --c-fixable: #2b3bff; --c-accent: #2b3bff;
  --mono: "JetBrains Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${DARK}} }
:root[data-theme="dark"] {${DARK}}
* { box-sizing: border-box; border-radius: 0 !important; }
html { font-size: 18px; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--mono); line-height: 1.45; font-variant-ligatures: none; }
button { font: inherit; color: inherit; }
a { color: var(--accent); }
code { font-family: var(--mono); font-size: 0.9em; }
.muted { color: var(--muted); }
.top { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 18px 48px; border-bottom: 1px solid var(--hair); }
.top h1 { margin: 0; font-size: 1.35rem; font-weight: 800; letter-spacing: 0.02em; text-transform: uppercase; }
.stats { display: flex; align-items: center; gap: 32px; }
.stat { display: flex; align-items: baseline; gap: 10px; }
.stat b { font-size: 1.6rem; font-weight: 800; font-variant-numeric: tabular-nums; }
.stat span { font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.12em; }
.stat.s-done b { color: var(--done); } .stat.s-warn b { color: var(--pause); }
.live .pulse { display: block; width: 10px; height: 10px; background: var(--dim); }
.live.on .pulse { background: var(--done); animation: blink 1.4s steps(2, start) infinite; }
.live.off .pulse { background: var(--pause); }
.theme { border: 1px solid var(--hair); background: transparent; padding: 4px 10px; cursor: pointer; color: var(--muted); }
@keyframes blink { to { visibility: hidden; } }
.strip { padding: 14px 48px; border-bottom: 1px solid var(--hair); }
.scrapers { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 14px 40px; }
.scraper { display: flex; align-items: center; gap: 16px; }
.sc-name { font-size: 1rem; font-weight: 700; }
.sc-state { display: inline-flex; align-items: center; gap: 10px; padding: 6px 14px; font-size: 1.05rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; border: 2px solid var(--done); color: var(--done); }
.sc-light { width: 10px; height: 10px; background: currentColor; }
.s-paused .sc-state { border-color: var(--pause); background: var(--pause); color: #000; }
.s-healing .sc-state { border-color: var(--accent); background: var(--accent); color: #fff; }
.s-healing .sc-light { animation: blink 0.7s steps(2, start) infinite; }
.s-down .sc-state { border-color: var(--fail); color: var(--fail); }
.panel-empty { margin: 0; color: var(--muted); font-size: 0.85rem; }
.fake { padding: 4px 48px; color: var(--pause); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; }
main { max-width: 1800px; margin: 0 auto; padding: 40px 48px 80px; }
.empty { text-align: center; padding: 120px 16px; color: var(--muted); }
.empty-title { font-size: 1.6rem; color: var(--muted); margin: 0; }
#cards { display: flex; flex-direction: column; }
.card { position: relative; }
.card-line { display: none; }
/* The newest run is the hero; earlier runs collapse to one line each. */
#cards > .card:first-child { padding-bottom: 32px; }
#cards > .card:nth-child(2) { margin-top: 24px; border-top: 1px solid var(--hair); padding-top: 34px; }
#cards > .card:nth-child(2)::before { content: 'Earlier runs'; position: absolute; top: 8px; left: 0; font-size: 0.68rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.14em; }
#cards > .card:not(:first-child) > .card-line { display: flex; }
#cards > .card:not(:first-child):not(.open) > :not(.card-line) { display: none; }
#cards > .card:not(:first-child).open { padding: 0 0 28px; }
.card-line { width: 100%; align-items: center; gap: 16px; padding: 10px 0; background: transparent; border: 0; border-bottom: 1px solid var(--hair); cursor: pointer; text-align: left; font-size: 0.85rem; color: var(--muted); }
.card-line:hover { color: var(--text); }
.line-scraper { font-weight: 700; color: var(--text); }
.line-title { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.card-line .badge { font-size: 0.68rem; }
.card-head { display: grid; grid-template-columns: 1fr auto; gap: 8px 24px; align-items: end; margin-bottom: 36px; }
.kicker { display: flex; gap: 16px; align-items: center; font-size: 0.85rem; color: var(--muted); }
.kind { font-size: 0.7rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.12em; padding: 3px 8px; border: 1px solid var(--muted); color: var(--muted); }
.scraper-name { font-weight: 700; color: var(--text); }
.short-id { color: var(--muted); text-decoration: none; }
.card-title { grid-column: 1; margin: 0; font-size: 1.5rem; line-height: 1.3; font-weight: 700; word-break: break-word; }
.card-flags { grid-column: 2; grid-row: 1 / span 2; }
.card-flags .badge { font-size: 0.9rem; padding: 8px 16px; }
.badge { display: inline-block; padding: 2px 8px; font-weight: 800; font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.08em; white-space: nowrap; border: 2px solid currentColor; color: var(--muted); }
.badge.t-good { color: var(--done); } .badge.t-bad { color: var(--fail); } .badge.t-warn { color: var(--pause); }
.badge.t-info, .badge.t-active { color: var(--accent); }
.flow { display: flex; flex-direction: column; gap: 28px; }
.lane { display: grid; grid-template-columns: 110px minmax(0, 1fr); align-items: start; }
.lane-name { padding-top: 34px; font-size: 0.68rem; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.14em; }
.nodes { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); column-gap: 12px; row-gap: 22px; }
.node { position: relative; grid-row: 1; min-width: 0; }
.node + .node::before { content: ''; position: absolute; top: 42px; left: -12px; width: 12px; height: 2px; background: var(--dim); }
.n-box { display: flex; flex-direction: column; justify-content: center; gap: 4px; width: 100%; height: 86px; padding: 10px 12px; text-align: left; background: transparent; border: 2px solid var(--hair); color: var(--muted); }
button.n-box, button.b-box { cursor: pointer; }
.n-mark { font-size: 0.8rem; font-weight: 800; line-height: 1; min-height: 0.8rem; }
.n-label { font-size: 1.05rem; font-weight: 700; line-height: 1.2; overflow-wrap: break-word; }
.s-pending .n-box { opacity: 0.4; }
.s-skipped .n-box { opacity: 0.18; border-style: dashed; }
.s-done .n-box { color: var(--text); border-color: var(--dim); }
.s-done .n-mark { color: var(--done); }
.s-paused .n-box, .s-warn .n-box { border-color: var(--pause); color: var(--pause); }
.s-failed .n-box, .s-stopped .n-box { border-color: var(--fail); color: var(--fail); }
.s-active .n-box { border-color: var(--accent); background: var(--accent); color: var(--accent-ink); position: relative; overflow: hidden; animation: glow 1.6s ease-in-out infinite; }
.s-active .n-mark { animation: blink 1s steps(2, start) infinite; }
.s-active .n-box::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: repeating-linear-gradient(90deg, var(--accent-ink) 0 10px, transparent 10px 20px); animation: march 0.7s linear infinite; }
@keyframes glow { 50% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 30%, transparent); } }
@keyframes march { to { background-position: 20px 0; } }
.n-box.sel, .b-box.sel { outline: 2px solid var(--text); outline-offset: 3px; }
.branch { grid-row: 2; position: relative; min-width: 0; }
.branch::before { content: ''; position: absolute; top: -22px; left: var(--at); width: 2px; height: 22px; background: var(--pause); }
.branch.b-failed::before { background: var(--fail); }
.b-box { width: 100%; padding: 10px 14px; text-align: left; background: transparent; border: 2px solid var(--pause); color: var(--pause); font-size: 0.9rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; }
.b-failed .b-box { border-color: var(--fail); color: var(--fail); }
.now { margin: 44px 0 0 110px; }
.now-text { margin: 0; font-size: 1.9rem; font-weight: 700; line-height: 1.3; max-width: 1400px; }
.now-visual { margin-top: 20px; }
.now .bars { max-width: 760px; gap: 10px; }
.now .bar { grid-template-columns: 170px 1fr 80px; font-size: 1.05rem; }
.now .track { height: 22px; }
.extra { margin: 36px 0 0 110px; }
.extra > summary { cursor: pointer; list-style: none; font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.14em; }
.extra > summary::-webkit-details-marker { display: none; }
.extra > summary::before { content: '+ '; }
.extra[open] > summary::before { content: '− '; }
.extra[open] { font-size: 0.85rem; }
.explain { margin: 16px 0 0; padding: 12px 16px; border-left: 3px solid var(--accent); background: var(--soft); line-height: 1.55; }
.explain-by { display: block; font-size: 0.68rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.14em; color: var(--accent); margin-bottom: 4px; }
.tail { margin-top: 16px; border: 1px solid var(--hair); }
.tail-head { display: flex; align-items: center; gap: 8px; padding: 5px 10px; font-size: 0.68rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.14em; color: var(--accent); }
.tail-dot { width: 8px; height: 8px; background: var(--accent); animation: blink 0.8s steps(2, start) infinite; }
.tail .log { border: 0; margin: 0; }
.log { margin: 6px 0 0; padding: 8px 10px; font-family: var(--mono); font-size: 0.75rem; line-height: 1.55; white-space: pre-wrap; word-break: break-word; overflow: auto; max-height: 280px; background: var(--soft); border: 1px solid var(--hair); }
.ll-t { color: var(--muted); }
.panes { margin-top: 16px; }
.pane { border: 1px solid var(--hair); border-left: 3px solid var(--dim); padding: 12px 16px 14px; }
.pane.p-active { border-left-color: var(--accent); } .pane.p-failed, .pane.p-stopped { border-left-color: var(--fail); }
.pane.p-paused, .pane.p-warn, .pane.p-human { border-left-color: var(--pause); } .pane.p-done { border-left-color: var(--done); }
.pane-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; font-size: 0.8rem; margin-bottom: 6px; }
.pane-stage { font-size: 0.95rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; }
.tag { font-size: 0.66rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; padding: 1px 6px; border: 1px solid currentColor; color: var(--muted); }
.tag.s-done { color: var(--done); } .tag.s-active { color: var(--accent); } .tag.s-failed, .tag.s-stopped { color: var(--fail); }
.tag.s-paused, .tag.s-warn, .tag.s-human { color: var(--pause); }
.summary { margin: 6px 0 0; }
.timeline { list-style: none; padding: 0; margin: 12px 0 0; border-top: 1px solid var(--hair); }
.row { display: grid; grid-template-columns: 90px 190px 1fr; gap: 12px; padding: 3px 0; border-bottom: 1px solid var(--hair); font-size: 0.75rem; color: var(--muted); }
.row-time { text-align: right; }
.row-stage { font-weight: 700; color: var(--text); }
.r-failed .row-sum { color: var(--fail); } .r-warn .row-sum { color: var(--pause); }
.meta { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 10px; font-size: 0.8rem; color: var(--muted); }
.meta b, .cost { color: var(--text); font-weight: 700; }
.meta .yes { color: var(--done); } .meta .no { color: var(--fail); }
.bars { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; max-width: 620px; }
.bar { display: grid; grid-template-columns: 130px 1fr 56px; gap: 12px; align-items: center; font-size: 0.82rem; color: var(--muted); }
.bar.strong { color: var(--text); font-weight: 800; }
.bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.track { position: relative; height: 14px; background: var(--soft); border: 1px solid var(--dim); }
.fill { display: block; height: 100%; transition: width 0.6s ease; }
.fill.c-benign { background: var(--c-benign); } .fill.c-minor { background: var(--c-minor); } .fill.c-critical { background: var(--c-critical); }
.fill.c-fixable { background: var(--c-fixable); } .fill.c-accent { background: var(--c-accent); }
.mark { position: absolute; top: -6px; bottom: -6px; width: 2px; background: var(--text); }
.bar-val { text-align: right; font-variant-numeric: tabular-nums; }
.triage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 8px 32px; }
.sub { margin-top: 8px; }
.sub-key { font-size: 0.68rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.14em; color: var(--muted); margin-top: 10px; }
.guard { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.findings { margin: 6px 0 0; padding-left: 20px; }
.findings li { margin: 3px 0; word-break: break-word; }
.findings.t-bad li::marker { color: var(--fail); } .findings.t-warn li::marker { color: var(--pause); }
.block { margin-top: 8px; border: 1px solid var(--hair); background: var(--soft); }
.block summary { cursor: pointer; padding: 5px 10px; font-size: 0.7rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); }
.block pre { margin: 0; padding: 10px 12px; max-height: 380px; overflow: auto; font-family: var(--mono); font-size: 0.75rem; line-height: 1.5; white-space: pre; border-top: 1px solid var(--hair); }
.diff .d-add { color: var(--done); background: var(--done-soft); display: inline-block; min-width: 100%; }
.diff .d-del { color: var(--fail); background: var(--fail-soft); display: inline-block; min-width: 100%; }
.diff .d-hunk { color: var(--accent); } .diff .d-file { color: var(--muted); font-weight: 800; }
.more { font-size: 0.75rem; color: var(--muted); padding: 4px 12px 8px; }
pre.err { margin: 8px 0 0; padding: 10px 12px; background: var(--fail-soft); color: var(--fail); border: 1px solid var(--fail); font-family: var(--mono); font-size: 0.75rem; white-space: pre-wrap; max-height: 240px; overflow: auto; }
.kv-val { margin: 6px 0 0; }
.warn-text { color: var(--pause); } .bad-text { color: var(--fail); }
.link-btn { display: inline-block; margin-right: 12px; padding: 10px 18px; background: var(--accent); color: var(--accent-ink); font-weight: 800; text-decoration: none; font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.08em; }
@media (max-width: 1280px) {
  .lane { grid-template-columns: 1fr; }
  .lane-name { padding: 0 0 8px; }
  .nodes { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); }
  .node, .branch { grid-row: auto; }
  .node + .node::before, .branch::before { display: none; }
  .branch { grid-column: 1 / -1 !important; }
  .now, .extra { margin-left: 0; }
}
@media (max-width: 760px) {
  html { font-size: 15px; }
  .top, .strip, main { padding-left: 16px; padding-right: 16px; }
  .card-head { grid-template-columns: 1fr; }
  .card-flags { grid-column: 1; grid-row: auto; }
  .now-text { font-size: 1.4rem; }
  .row { grid-template-columns: 1fr; gap: 2px; }
  .row-time { text-align: left; }
}
`;
