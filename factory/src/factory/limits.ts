// Hard limits on a fix, checked in code so no model (and no text a model read) can talk its way past them.

export type FileChange = { file: string; added: number; removed: number };

export type LimitsReport = { ok: boolean; breaches: string[]; productionLines: number; testFiles: string[] };

export const MAX_PRODUCTION_LINES = 120;

const ALLOWED = [/^src\/parsers\//, /^tests\//];
const FORBIDDEN = [/(^|\/)package\.json$/, /lock\.ya?ml$/, /-lock\.json$/, /^\.github\//, /(^|\/)tsconfig[^/]*\.json$/, /(^|\/)\.env/];

export function checkLimits(changes: FileChange[], maxProductionLines = MAX_PRODUCTION_LINES): LimitsReport {
    const breaches: string[] = [];
    for (const { file } of changes) {
        if (FORBIDDEN.some((pattern) => pattern.test(file))) breaches.push(`changes a protected file: ${file}`);
        else if (!ALLOWED.some((pattern) => pattern.test(file))) breaches.push(`changes a file outside src/parsers and tests: ${file}`);
    }
    const production = changes.filter(({ file }) => !file.startsWith('tests/'));
    const productionLines = production.reduce((sum, { added, removed }) => sum + added + removed, 0);
    if (production.length === 0) breaches.push('changes no production code');
    if (productionLines > maxProductionLines) {
        breaches.push(`changes ${productionLines} lines of production code (limit ${maxProductionLines})`);
    }
    const testFiles = changes.map(({ file }) => file).filter((file) => /^tests\/.*\.test\.ts$/.test(file));
    if (testFiles.length === 0) breaches.push('adds or changes no test');
    return { ok: breaches.length === 0, breaches, productionLines, testFiles };
}
