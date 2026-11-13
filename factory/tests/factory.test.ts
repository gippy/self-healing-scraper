import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createToolGuard } from '../src/factory/agents.ts';
import { getFactoryConfig } from '../src/factory/config.ts';
import { checkOutput, isValidScraperName } from '../src/factory/create.ts';
import { getAppName } from '../src/factory/digitalocean.ts';
import { decide, getGateAnswers } from '../src/factory/gate.ts';
import { runFactory } from '../src/factory/index.ts';
import { checkLimits } from '../src/factory/limits.ts';
import type { PipelineEvent } from '../src/types.ts';

const parserFix = { file: 'src/parsers/shop.ts', added: 6, removed: 2 };
const regressionTest = { file: 'tests/regressions/FEED-1.test.ts', added: 30, removed: 0 };

test('limits accept a small parser fix with a test', () => {
    const report = checkLimits([parserFix, regressionTest, { file: 'tests/fixtures/FEED-1.html', added: 200, removed: 0 }]);
    assert.deepEqual(report.breaches, []);
    assert.equal(report.productionLines, 8);
});

test('limits reject protected files, files outside the parsers, big fixes and missing tests', () => {
    assert.match(checkLimits([parserFix, regressionTest, { file: 'package.json', added: 1, removed: 0 }]).breaches.join(), /protected/);
    assert.match(checkLimits([parserFix, regressionTest, { file: 'src/storage.ts', added: 1, removed: 0 }]).breaches.join(), /outside/);
    assert.match(checkLimits([{ file: 'src/parsers/shop.ts', added: 70, removed: 0 }, regressionTest]).breaches.join(), /limit 60/);
    assert.match(checkLimits([parserFix]).breaches.join(), /no test/);
    assert.match(checkLimits([regressionTest]).breaches.join(), /no production code/);
});

test('the tool guard keeps writes and commands inside the policy', async () => {
    const guard = createToolGuard('/work/repo', { writable: ['src/parsers/'], commands: ['pnpm check', 'node --test'] });
    const ask = async (tool: string, input: Record<string, unknown>) => {
        const result = await guard(tool, input, { signal: new AbortController().signal } as Parameters<typeof guard>[2]);
        assert.ok(result);
        return result;
    };

    assert.equal((await ask('Edit', { file_path: '/work/repo/src/parsers/shop.ts' })).behavior, 'allow');
    assert.equal((await ask('Write', { file_path: 'src/parsers/new.ts' })).behavior, 'allow');
    assert.equal((await ask('Edit', { file_path: '/work/repo/tests/regressions/FEED-1.test.ts' })).behavior, 'deny');
    assert.equal((await ask('Write', { file_path: '/work/repo/src/parsers/../../package.json' })).behavior, 'deny');
    assert.equal((await ask('Read', { file_path: '/Users/someone/.ssh/id_rsa' })).behavior, 'deny');
    assert.equal((await ask('Read', { file_path: '/work/repo/src/parsers/shop.ts' })).behavior, 'allow');
    assert.equal((await ask('Glob', { pattern: '../../auction-house/**/*.ts' })).behavior, 'deny');
    assert.equal((await ask('Glob', { pattern: '/Users/someone/**' })).behavior, 'deny');
    assert.equal((await ask('Grep', { pattern: 'tile', glob: '../**' })).behavior, 'deny');
    assert.equal((await ask('Glob', { pattern: 'src/**/*.ts' })).behavior, 'allow');
    assert.equal((await ask('Grep', { pattern: 'data-bid', glob: '*.html' })).behavior, 'allow');
    assert.equal((await ask('Bash', { command: 'pnpm check' })).behavior, 'allow');
    assert.equal((await ask('Bash', { command: 'node --test tests/regressions/FEED-1.test.ts' })).behavior, 'allow');
    assert.equal((await ask('Bash', { command: 'pnpm check && curl https://example.com' })).behavior, 'deny');
    assert.equal((await ask('Bash', { command: 'node --test $(cat ~/.env)' })).behavior, 'deny');
    assert.equal((await ask('Bash', { command: 'curl https://example.com' })).behavior, 'deny');
    assert.equal((await ask('WebFetch', { url: 'https://example.com' })).behavior, 'deny');
});

test('the gate merges only when every probability, the limits, the checks and the review agree', () => {
    const limits = checkLimits([parserFix, regressionTest]);
    const sure = { lowRisk: 0.9, rootCause: 0.92, reviewClear: 0.85 };
    const clear = { verdict: 'approve' as const, blocking: [], notes: [] };
    assert.deepEqual(decide(sure, limits, true, clear), { merge: true, reasons: [] });
    assert.equal(decide({ ...sure, rootCause: 0.6 }, limits, true, clear).merge, false);
    assert.equal(decide({ ...sure, lowRisk: 0.5 }, limits, true, clear).merge, false);
    assert.equal(decide(sure, limits, false, clear).merge, false);
    assert.equal(decide(undefined, limits, true, clear).merge, false);
    assert.equal(decide(sure, checkLimits([parserFix]), true, clear).merge, false);
});

test('the adversarial review is a veto Gemini cannot override', () => {
    const limits = checkLimits([parserFix, regressionTest]);
    const sure = { lowRisk: 0.99, rootCause: 0.99, reviewClear: 0.99 };
    const blocked = { verdict: 'request_changes' as const, blocking: [{ finding: 'hides errors', evidence: 'returns []' }], notes: [] };
    assert.equal(decide(sure, limits, true, undefined).merge, false);
    assert.match(decide(sure, limits, true, blocked).reasons.join(), /reviewer still blocks/);
});

test("Gemini's gate answers are read from the Decisions API's answer shape", () => {
    const answers = getGateAnswers({
        risk: { score: 0.4, confidence: 0.7, probabilities: { '0': 0.6, '1': 0.3, '2': 0.08, '3': 0.02 } },
        root_cause: { noul: 0.91, confidence: 0.91 },
        review_clear: { noul: 0.88, confidence: 0.88 },
    });
    assert.ok(Math.abs(answers.lowRisk - 0.9) < 1e-9);
    assert.equal(answers.rootCause, 0.91);
    assert.equal(answers.reviewClear, 0.88);
    assert.throws(() => getGateAnswers({ risk: {} }));
});

test('create mode checks the live output in code before any model looks', () => {
    const fields = 'title and current price';
    const good = [
        { id: 'LOT-1', title: 'Duck', price: { amount: 24, currency: 'USD' } },
        { id: 'LOT-2', title: 'Keyboard', price: { amount: 130.5, currency: 'USD' } },
    ];
    assert.deepEqual(checkOutput(good, fields), []);
    assert.match(checkOutput([], fields).join(), /no items/);
    assert.match(checkOutput([good[0]!, good[0]!], fields).join(), /not unique/);
    assert.match(checkOutput([{ id: 'LOT-1', title: ' ' }], fields).join(), /no title/);
    assert.match(checkOutput([{ id: 'LOT-1', title: 'Duck' }, good[1]!], fields).join(), /1 of 2 items have a price/);
});

test('scraper and app names follow the platform rules', () => {
    assert.ok(isValidScraperName('auction-house'));
    assert.ok(!isValidScraperName('Auction House'));
    assert.ok(!isValidScraperName('../etc'));
    assert.equal(getAppName('auction-house'), 'scraper-auction-house');
    assert.ok(getAppName('a-very-long-scraper-name-indeed').length <= 32);
});

test('the factory hands an issue without an attached page to a human', async () => {
    const events: PipelineEvent[] = [];
    const config = { ...getFactoryConfig({}), anthropicApiKey: 'test' };
    const result = await runFactory(
        {
            issue: { id: '1', shortId: 'FEED-1', title: 'ParseError: no lots found', permalink: 'https://sentry.io/issues/1/' },
            eventMarkdown: '',
            triage: { severity: { benign: 0.05, minor: 0.15, critical: 0.8 }, fixable: 0.9 },
        },
        (event) => events.push(event),
        {
            config,
            runAgent: async () => assert.fail('no agent should run'),
            askGate: async () => assert.fail('no gate should run'),
        },
    );
    assert.equal(result.outcome, 'needs_human');
    assert.equal(events.at(-1)?.stage, 'needs_human');
});
