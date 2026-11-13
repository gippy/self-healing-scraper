import assert from 'node:assert/strict';
import { test } from 'node:test';

import { redact } from '../../src/triage/redact.ts';

const SECRETS: Array<[string, string]> = [
    ['anthropic', 'key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
    ['openai', 'OPENAI sk-proj-AbCdEfGhIjKlMnOpQrStUvWx'],
    ['github', 'token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
    ['github', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop'],
    ['apify', 'apify_api_AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
    ['sentry', 'sntrys_eyJpYXQiOjE3MDAwMDAwMDAuMDAwMDAwLCJ1cmwiOiJodHRwczovL3NlbnRyeS5pbyJ9'],
    ['aws', 'AKIAIOSFODNN7EXAMPLE'],
    ['slack', 'xoxb-1234567890-abcdefghij'],
    ['stripe', 'sk_live_AbCdEfGhIjKlMnOpQrSt'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['bearer', 'Authorization: Bearer abcdef0123456789abcdef'],
    ['url-credentials', 'SENTRY_DSN=https://0123456789abcdef0123456789abcdef@o123.ingest.sentry.io/456'],
    ['query', 'GET https://api.brightdata.com/request?token=abc123secretvalue&zone=unlocker'],
    ['assignment', '{"password": "hunter2hunter2"}'],
    ['assignment', 'client_secret=0a1b2c3d4e5f6a7b8c9d'],
];

const SECRET_VALUES = [
    'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'AbCdEfGhIjKlMnOpQrStUvWx',
    'AKIAIOSFODNN7EXAMPLE',
    'abcdef0123456789abcdef',
    '0123456789abcdef0123456789abcdef',
    'abc123secretvalue',
    'hunter2hunter2',
    '0a1b2c3d4e5f6a7b8c9d',
    'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
];

for (const [kind, text] of SECRETS) {
    test(`redacts ${kind}: ${text.slice(0, 24)}…`, () => {
        const result = redact(text);
        assert.ok(result.count >= 1, result.text);
        assert.match(result.text, /\[REDACTED:/);
        for (const value of SECRET_VALUES) assert.ok(!result.text.includes(value), `${value} leaked in ${result.text}`);
    });
}

test('keeps the readable parts around a secret', () => {
    const { text } = redact('Authorization: Bearer abcdef0123456789abcdef');
    assert.equal(text, 'Authorization: Bearer [REDACTED:bearer]');
    assert.equal(redact('https://api.example.com/x?token=abc123secretvalue&zone=u').text, 'https://api.example.com/x?token=[REDACTED:query]&zone=u');
});

test('leaves ordinary event text and HTML alone', () => {
    const text = `# ParseError: shop: cannot read bid "1 299 Kč"
Event 0f1e2d3c4b5a69788796a5b4c3d2e1f0 · release feed@3f2c1ab
- in app src/parsers/shop.ts:32 in parseBid
<li class="lot" data-lot="LOT-001"><span class="lot-bid">$1,299.00</span><span class="lot-bids">7 bids</span></li>
<form class="signin"><input type="password" name="password"><button>Sign in</button></form>
https://selfheal.sentry.io/issues/4517290001/
tokens used: 120`;
    const result = redact(text);
    assert.equal(result.count, 0, result.text);
    assert.equal(result.text, text);
});
