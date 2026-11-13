// Runs the factory once on a local repo and a saved page, printing every pipeline event.
//   node --env-file-if-exists=.env scripts/try-factory.ts <repo path> <page that broke the parser>
// Defaults to a dry run (FACTORY_SHIP=0): nothing is pushed, opened or merged.
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { getFactoryConfig } from '../src/factory/config.ts';
import { askGate } from '../src/factory/gate.ts';
import { runFactory } from '../src/factory/index.ts';
import { runAgent } from '../src/factory/agents.ts';

const [repo, page] = process.argv.slice(2);
if (!repo || !page) throw new Error('usage: try-factory.ts <repo path> <page>');

const config = {
    ...getFactoryConfig({ ...process.env, FACTORY_SHIP: process.env.FACTORY_SHIP ?? '0' }),
    targetRepo: resolve(repo),
};
const started = Date.now();
const result = await runFactory(
    {
        issue: {
            id: 'local',
            shortId: 'FEED-LOCAL',
            title: 'ParseError: shop: no lots found',
            permalink: 'https://sentry.io/issues/local/',
        },
        source: 'shop',
        eventMarkdown: `# ParseError: shop: no lots found

Tags: source=shop, parser=shop
The shop parser threw while reading the page attached as ${basename(page)}.

    ParseError: shop: no lots found
      at parse (src/parsers/shop.ts:24:44)
      at pollSource (src/poller.ts:41:19)`,
        attachment: { name: 'raw.html', content: await readFile(page, 'utf8') },
        triage: { severity: { benign: 0.03, minor: 0.12, critical: 0.85 }, fixable: 0.88 },
    },
    (event) => {
        const seconds = ((Date.now() - started) / 1000).toFixed(0).padStart(4);
        console.log(`${seconds}s ${event.stage.padEnd(14)} ${event.status.padEnd(7)} ${event.summary}`);
        if (event.status !== 'started' && event.data) console.log(JSON.stringify(event.data, null, 2).slice(0, 3_000));
    },
    { config, runAgent, askGate },
);
console.log('\nResult:', result);
