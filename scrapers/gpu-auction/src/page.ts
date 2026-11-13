import type { Item } from './parsers/item.ts';
import type { ScraperStatus } from './scraper.ts';

const MAX_ROWS = 50;

const CSS = `:root{--bg:#f6f7f9;--surface:#fff;--text:#14171c;--muted:#5f6b7a;--line:#e1e5eb;--ok:#15803d;--ok-bg:#dcfce7;--bad:#b91c1c;--bad-bg:#fee2e2;--pause:#92400e;--pause-bg:#fef3c7}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--surface:#181b21;--text:#e8ebf0;--muted:#97a1ae;--line:#2a2f38;--ok:#4ade80;--ok-bg:#12321f;--bad:#fca5a5;--bad-bg:#3b1515;--pause:#fcd34d;--pause-bg:#3a2a08}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header,main{max-width:1080px;margin:0 auto;padding:16px}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px;border-bottom:1px solid var(--line)}
h1{margin:0;font-size:22px}
.muted{color:var(--muted)}
.mono{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.badge{font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px}
.ok{background:var(--ok-bg);color:var(--ok)}.bad{background:var(--bad-bg);color:var(--bad)}.paused{background:var(--pause-bg);color:var(--pause)}
.banner{margin:16px 0;padding:12px 16px;border-radius:10px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:16px 0}
dt{color:var(--muted)}dd{margin:0}
.table{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:10px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 12px;border-top:1px solid var(--line);white-space:nowrap}
th{border-top:0;color:var(--muted);font-weight:600;font-size:13px}
td.title{white-space:normal;min-width:220px}
td.num{text-align:right}`;

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function formatPrice(price: Item['price']): string {
  if (!price) return '';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: price.currency }).format(price.amount);
  } catch {
    return `${price.amount} ${price.currency}`;
  }
}

/** The status page: paused or not, last poll, last error, newest items. Reloads itself every 10 s. */
export function renderStatusPage(status: ScraperStatus, items: Item[], release: string | undefined): string {
  const badge = status.paused
    ? '<span class="badge paused">paused</span>'
    : status.lastPoll
      ? status.lastPoll.ok
        ? '<span class="badge ok">ok</span>'
        : '<span class="badge bad">failing</span>'
      : '<span class="badge">waiting for the first poll</span>';
  const pausedBanner = status.paused
    ? `<div class="banner paused"><strong>Paused${status.issue ? ` for ${escapeHtml(status.issue)}` : ''}</strong> since ${escapeHtml(status.pausedAt)}: ${escapeHtml(status.reason)}</div>`
    : '';
  const errorBanner =
    status.lastError && !status.lastPoll?.ok
      ? `<div class="banner bad mono">${escapeHtml(status.lastError.message)}</div>`
      : '';
  const rows = items
    .slice(0, MAX_ROWS)
    .map(
      (item) => `<tr><td class="mono">${escapeHtml(item.id)}</td><td class="title">${
        item.url ? `<a href="${escapeHtml(item.url)}" rel="noopener">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)
      }</td><td>${escapeHtml(item.category)}</td><td class="num">${escapeHtml(formatPrice(item.price))}</td><td class="num">${escapeHtml(item.bids)}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.endsAt)}</td></tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>${escapeHtml(status.scraper)} scraper</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>${escapeHtml(status.scraper)}</h1>
  ${badge}
  <span class="muted mono">${escapeHtml(status.targetUrl)}</span>
</header>
<main>
${pausedBanner}${errorBanner}
<dl>
  <dt>Last poll</dt><dd>${status.lastPoll ? `${escapeHtml(status.lastPoll.at)}, ${status.lastPoll.ok ? `${status.lastPoll.items} items` : 'failed'}, ${status.lastPoll.ms} ms` : 'none yet'}</dd>
  <dt>Last success</dt><dd>${escapeHtml(status.lastOkAt ?? 'none yet')}</dd>
  <dt>Last error</dt><dd class="mono">${status.lastError ? `${escapeHtml(status.lastError.at)}: ${escapeHtml(status.lastError.message)}` : 'none'}</dd>
  <dt>Items go to</dt><dd>${status.sink === 'snowflake' ? 'Snowflake, table SCRAPED_ITEMS' : 'the log only (Snowflake not configured)'}</dd>
  <dt>Release</dt><dd class="mono">${escapeHtml(release ?? 'none')}</dd>
</dl>
<h2>Newest items${status.scrapedAt ? ` <span class="muted">(${items.length}, scraped ${escapeHtml(status.scrapedAt)})</span>` : ''}</h2>
${items.length === 0 ? '<p class="muted">No items yet.</p>' : `<div class="table"><table>
<thead><tr><th>ID</th><th>Title</th><th>Category</th><th>Price</th><th>Bids</th><th>Status</th><th>Ends</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`}
</main>
</body>
</html>
`;
}
