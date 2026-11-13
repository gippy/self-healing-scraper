import { LAYOUT_DESCRIPTIONS, LAYOUTS, type Layout } from './layouts.ts';
import { escapeHtml, renderPage } from './page.ts';

const ADMIN_CSS = `.admin h1{margin:0 0 4px;font-size:26px}
.admin .hint{margin:0 0 20px;color:var(--muted)}
.secret{display:flex;gap:8px;align-items:center;margin-bottom:20px;font-size:14px;color:var(--muted)}
.secret input{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text)}
.layouts{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.layouts li{display:flex;gap:14px;align-items:center;padding:12px 14px;background:var(--surface);border:1px solid var(--line);border-radius:10px}
.layouts li.current{border-color:var(--accent)}
.layouts button{font:inherit;font-weight:600;min-width:150px;padding:8px 12px;border:1px solid var(--accent);border-radius:8px;background:transparent;color:var(--accent);cursor:pointer}
.layouts li.current button{background:var(--accent);color:#fff}
.layouts span{color:var(--muted);font-size:15px}
.status{min-height:24px;margin-top:16px;font-size:14px}`;

// Sends the layout switch with the secret from the input, then marks the new current layout.
const ADMIN_SCRIPT = `(function(){var input=document.querySelector('#secret'),status=document.querySelector('.status');
try{input.value=localStorage.getItem('shop-admin-secret')||''}catch(e){}
input.addEventListener('change',function(){try{localStorage.setItem('shop-admin-secret',input.value)}catch(e){}});
document.querySelectorAll('.layouts button').forEach(function(button){button.addEventListener('click',async function(){
var layout=button.dataset.layout;status.textContent='Switching to '+layout+'...';
try{var response=await fetch('/admin/layout',{method:'POST',headers:{'content-type':'application/json','x-admin-secret':input.value},body:JSON.stringify({layout:layout})});
if(!response.ok){status.textContent='Failed: '+response.status+' '+(await response.text());return}
document.querySelectorAll('.layouts li').forEach(function(li){li.classList.toggle('current',li.dataset.layout===layout)});
document.querySelector('.current-name').textContent=layout;status.textContent='Now serving '+layout+'.'}
catch(error){status.textContent='Failed: '+error}})})})();`;

export function renderAdmin(current: Layout): string {
  const rows = LAYOUTS.map(
    (layout) => `  <li data-layout="${layout}"${layout === current ? ' class="current"' : ''}>
    <button type="button" data-layout="${layout}">${layout}</button>
    <span>${escapeHtml(LAYOUT_DESCRIPTIONS[layout])}</span>
  </li>`,
  );
  return renderPage({
    title: 'Admin',
    css: ADMIN_CSS,
    main: `<main class="page admin">
<h1>Layout switch</h1>
<p class="hint">Current layout: <strong class="current-name">${current}</strong>. <a href="/">View the shop</a></p>
<label class="secret">Admin secret <input id="secret" type="password" autocomplete="off"></label>
<ul class="layouts">
${rows.join('\n')}
</ul>
<p class="status" role="status"></p>
</main>
<script>${ADMIN_SCRIPT}</script>`,
  });
}
