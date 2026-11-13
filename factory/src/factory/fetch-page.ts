// Fetches a page the way the deployed scrapers do: through Bright Data's Web Unlocker when it is configured,
// otherwise directly (local development).
export async function fetchPage(url: string, env: NodeJS.ProcessEnv = process.env): Promise<{ html: string; via: string }> {
    if (env.BRIGHTDATA_API_KEY && env.BRIGHTDATA_UNLOCKER_ZONE && env.FAKE_BRIGHTDATA !== '1') {
        for (let attempt = 1; ; attempt++) {
            const response = await fetch('https://api.brightdata.com/request', {
                method: 'POST',
                headers: { authorization: `Bearer ${env.BRIGHTDATA_API_KEY}`, 'content-type': 'application/json' },
                body: JSON.stringify({ zone: env.BRIGHTDATA_UNLOCKER_ZONE, url, format: 'raw' }),
                signal: AbortSignal.timeout(90_000),
            });
            if (response.ok) return { html: await response.text(), via: 'Bright Data Web Unlocker' };
            if (attempt >= 2 || response.status < 500) {
                const detail = response.headers.get('x-brd-error') ?? (await response.text()).slice(0, 300);
                throw new Error(`Bright Data answered ${response.status}: ${detail}`);
            }
        }
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return { html: await response.text(), via: 'a direct request' };
}
