// Runs the factory's create mode once and prints every pipeline event.
//   node --env-file-if-exists=.env scripts/try-create.ts <name> <url> [fields]
// Defaults to a dry run (FACTORY_SHIP=0): it builds and verifies, but pushes, merges and deploys nothing.
import { getFactoryConfig } from '../src/factory/config.ts';
import { createScraper } from '../src/factory/create.ts';

const [name, url, fields] = process.argv.slice(2);
if (!name || !url) throw new Error('usage: try-create.ts <name> <url> [fields]');

const config = getFactoryConfig({ ...process.env, FACTORY_SHIP: process.env.FACTORY_SHIP ?? '0' });
const started = Date.now();
const result = await createScraper({ name, url, fields }, (event) => {
    const seconds = ((Date.now() - started) / 1000).toFixed(0).padStart(4);
    console.log(`${seconds}s ${event.stage.padEnd(12)} ${event.status.padEnd(7)} ${event.summary}`);
    if (event.status !== 'started' && event.data) console.log(JSON.stringify(event.data, null, 2).slice(0, 2_500));
}, config);
console.log('\nResult:', result);
