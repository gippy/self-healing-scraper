import { BRAND, type Category } from './catalog.ts';

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Picks the stored theme or the system one before the first paint, so the page does not flash.
const THEME_HEAD_SCRIPT = `(function(){var t;try{t=localStorage.getItem('theme')}catch(e){}
if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}
document.documentElement.dataset.theme=t})();`;

const THEME_BODY_SCRIPT = `(function(){var root=document.documentElement,button=document.querySelector('.theme-switch');
function setLabel(){button.textContent=root.dataset.theme==='dark'?'Light mode':'Dark mode'}
setLabel();button.addEventListener('click',function(){var next=root.dataset.theme==='dark'?'light':'dark';
root.dataset.theme=next;try{localStorage.setItem('theme',next)}catch(e){}setLabel()})})();`;

const BASE_CSS = `:root{--bg:#f7f3ec;--surface:#fff;--text:#1b1712;--muted:#6f665a;--line:#e7dfd2;--accent:#d9480f;--accent-soft:#ffe8d9;--ok:#2b8a3e;--bad:#e03131;--shadow:0 1px 2px rgba(60,40,10,.06),0 6px 20px rgba(60,40,10,.07)}
:root[data-theme=dark]{--bg:#12100d;--surface:#1d1a16;--text:#f4efe7;--muted:#a89f92;--line:#36302a;--accent:#ff8a3d;--accent-soft:#3d2414;--ok:#51cf66;--bad:#ff6b6b;--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35)}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:inherit}
.site-header{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:20px;padding:14px 28px;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:19px;letter-spacing:-.01em;text-decoration:none;white-space:nowrap}
.brand-mark{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:var(--accent);color:#fff;font-size:15px;font-weight:900}
.category-nav{display:flex;gap:4px;overflow-x:auto;flex:1;min-width:0;scrollbar-width:none}
.category-nav a{padding:6px 12px;border-radius:999px;font-size:14px;font-weight:600;color:var(--muted);text-decoration:none;white-space:nowrap}
.category-nav a:hover,.category-nav a.active{background:var(--accent-soft);color:var(--accent)}
.live-indicator{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:var(--muted);white-space:nowrap}
.live-indicator::before{content:"";width:9px;height:9px;border-radius:50%;background:var(--muted)}
.live-indicator.on{color:var(--ok)}
.live-indicator.on::before{background:var(--ok);box-shadow:0 0 0 0 var(--ok);animation:pulse 1.6s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--ok) 60%,transparent)}100%{box-shadow:0 0 0 10px transparent}}
.theme-switch{font:inherit;font-size:13px;padding:6px 12px;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--text);cursor:pointer;white-space:nowrap}
.page{max-width:1320px;margin:0 auto;padding:28px}
.site-footer{max-width:1320px;margin:0 auto;padding:28px;color:var(--muted);font-size:14px}
@media (max-width:640px){.site-header{flex-wrap:wrap;padding:12px 16px}.category-nav{order:3;flex-basis:100%}.page{padding:16px}}`;

export function renderPage(options: {
  title: string;
  css: string;
  main: string;
  categories?: Category[];
  activeCategory?: string;
  bodyAttributes?: string;
  scripts?: string;
}): string {
  const nav = options.categories
    ? `<nav class="category-nav"><a href="/"${options.activeCategory ? '' : ' class="active"'}>All lots</a>${options.categories
        .map(
          (category) =>
            `<a href="/c/${category.slug}"${category.slug === options.activeCategory ? ' class="active"' : ''}>${escapeHtml(category.name)}</a>`,
        )
        .join('')}</nav>
  <span class="live-indicator">Connecting</span>`
    : '<span style="flex:1"></span>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)} | ${escapeHtml(BRAND)}</title>
<script>${THEME_HEAD_SCRIPT}</script>
<style>
${BASE_CSS}
${options.css}
</style>
</head>
<body${options.bodyAttributes ? ` ${options.bodyAttributes}` : ''}>
<header class="site-header">
  <a class="brand" href="/"><span class="brand-mark">G&amp;G</span>${escapeHtml(BRAND)}</a>
  ${nav}
  <button class="theme-switch" type="button">Theme</button>
</header>
${options.main}
<footer class="site-footer">${escapeHtml(BRAND)} is a fictional auction house for a scraping demo. Nothing here is for sale.</footer>
<script>${THEME_BODY_SCRIPT}</script>${options.scripts ?? ''}
</body>
</html>
`;
}
