// Removes tokens, keys and passwords from event text before the guard, Gemini, the factory or the dashboard
// see it. Each match becomes [REDACTED:<kind>]; the count goes to the dashboard.

type Rule = { kind: string; pattern: RegExp; replace?: string };

const SECRET_KEYS =
    'api[_-]?key|apikey|x-api-key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|private[_-]?key|authorization|dsn';

const RULES: Rule[] = [
    { kind: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
    { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
    { kind: 'anthropic', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
    { kind: 'openai', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
    { kind: 'github', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
    { kind: 'apify', pattern: /\bapify_api_[A-Za-z0-9]{20,}/g },
    { kind: 'sentry', pattern: /\bsntry[su]?_[A-Za-z0-9+/=_-]{20,}/g },
    { kind: 'aws', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
    { kind: 'slack', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
    { kind: 'stripe', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
    { kind: 'google', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
    // Authorization header values.
    { kind: 'bearer', pattern: /\b(Bearer|Basic|Token)\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]{12,}/g, replace: '$1 [REDACTED:bearer]' },
    // Credentials in URLs, e.g. a Sentry DSN or https://user:pass@host.
    {
        kind: 'url-credentials',
        pattern: /\b([a-z][a-z0-9+.-]*:\/\/)(?!\[REDACTED)[^\s:@/?#"'<>]+(?::[^\s@/?#"'<>]*)?@/gi,
        replace: '$1[REDACTED:url-credentials]@',
    },
    // ?token=…&api_key=…
    {
        kind: 'query',
        pattern: new RegExp(`([?&](?:${SECRET_KEYS}|key|sig|signature)=)(?!\\[REDACTED)[^&\\s#"'<>]+`, 'gi'),
        replace: '$1[REDACTED:query]',
    },
    // password: "…", "api_key": "…", SECRET=…
    {
        kind: 'assignment',
        pattern: new RegExp(
            `(["']?\\b(?:${SECRET_KEYS})\\b["']?\\s*[:=]\\s*["']?)(?!\\[REDACTED|Bearer\\b|Basic\\b|Token\\b)([^\\s"',;}&<>]{6,})`,
            'gi',
        ),
        replace: '$1[REDACTED:assignment]',
    },
];

export function redact(text: string): { text: string; count: number } {
    let count = 0;
    let result = text;
    for (const rule of RULES) {
        result = result.replace(rule.pattern, (...args: unknown[]) => {
            count++;
            if (!rule.replace) return `[REDACTED:${rule.kind}]`;
            const groups = args.slice(1, -2) as Array<string | undefined>;
            return rule.replace.replace(/\$(\d)/g, (_, n: string) => groups[Number(n) - 1] ?? '');
        });
    }
    return { text: result, count };
}
