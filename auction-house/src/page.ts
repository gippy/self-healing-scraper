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

const BASE_CSS = `:root{--bg:#f1f1ec;--surface:#fff;--text:#0b0c0d;--muted:#5d6166;--line:#0b0c0d;--grid:#d6d6d0;--accent:#00a35c;--accent-2:#e35d00;--accent-soft:#c9f2dc;--ok:#00a35c;--bad:#e5132b;--shadow:none}
:root[data-theme=dark]{--bg:#050607;--surface:#0b0e11;--text:#e8ecef;--muted:#7c858e;--line:#2d343b;--grid:#1a1f24;--accent:#00ff85;--accent-2:#ffb000;--accent-soft:#073d24;--ok:#00ff85;--bad:#ff3355;--shadow:none}
*,*::before,*::after{box-sizing:border-box;border-radius:0 !important}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
input,button,select,textarea{font-family:inherit}
a{color:inherit}
.site-header{position:sticky;top:0;z-index:10;display:flex;align-items:stretch;background:var(--surface);border-bottom:2px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;padding:12px 18px;font-weight:800;font-size:15px;letter-spacing:.04em;text-transform:uppercase;text-decoration:none;white-space:nowrap;border-right:1px solid var(--line)}
.brand-mark{display:grid;place-items:center;width:30px;height:30px;background:var(--accent);color:#000;font-size:11px;font-weight:800}
.category-nav{display:flex;overflow-x:auto;flex:1;min-width:0;scrollbar-width:none}
.category-nav a{display:flex;align-items:center;padding:0 14px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);text-decoration:none;white-space:nowrap;border-right:1px solid var(--grid)}
.category-nav a:hover,.category-nav a.active{background:var(--text);color:var(--bg)}
.live-indicator{display:flex;align-items:center;gap:8px;padding:0 16px;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);white-space:nowrap;border-left:1px solid var(--line)}
.live-indicator::before{content:"";width:8px;height:8px;background:var(--muted)}
.live-indicator.on{color:var(--accent)}
.live-indicator.on::before{background:var(--accent);animation:blink 1s steps(2) infinite}
@keyframes blink{50%{opacity:.25}}
.theme-switch{padding:0 16px;border:0;border-left:1px solid var(--line);background:transparent;color:var(--text);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;cursor:pointer;white-space:nowrap}
.theme-switch:hover{background:var(--text);color:var(--bg)}
.page{max-width:1440px;margin:0 auto;padding:24px}
.site-footer{max-width:1440px;margin:0 auto;padding:20px 24px;color:var(--muted);font-size:12px;border-top:1px solid var(--grid)}
@media (max-width:640px){.site-header{flex-wrap:wrap}.category-nav{order:3;flex-basis:100%;border-top:1px solid var(--grid)}.category-nav a{padding:10px 12px}.page{padding:16px}}`;

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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&display=swap">
<script>${THEME_HEAD_SCRIPT}</script>
<style>
${BASE_CSS}
${options.css}
</style>
</head>
<body${options.bodyAttributes ? ` ${options.bodyAttributes}` : ''}>
<header class="site-header">
  <a class="brand" href="/"><span class="brand-mark">SA</span>${escapeHtml(BRAND)}</a>
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
