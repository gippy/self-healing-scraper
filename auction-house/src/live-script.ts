// The browser script that keeps a page live. It reads `data-live` on <body>:
// - `v1`: patches `li.lot` cards and the `ol.sold-list` strip;
// - `v2`: patches `article.tile` cards and the `.ticker`;
// - anything else: does nothing.
// Messages from GET /ws: `lot` (a new bid), `sold` and `new`.
export const LIVE_SCRIPT = `(function(){
var mode=document.body.dataset.live,onlyCategory=document.body.dataset.category||'',names=JSON.parse(document.body.dataset.categoryNames||'{}');
if(mode!=='v1'&&mode!=='v2')return;
var indicator=document.querySelector('.live-indicator'),MAX_SOLD=12;
function usd(n){return '$'+Number(n).toFixed(2)}
function bidsLabel(n){return n+(n===1?' bid':' bids')}
function isoSeconds(iso){return iso.replace(/\\.\\d{3}Z$/,'Z')}
function endsLabel(iso){var s=Math.round((new Date(iso)-Date.now())/1000);if(s<=0)return 'Closing';
var m=Math.floor(s/60),h=Math.floor(m/60);if(h>0)return 'Ends in '+h+'h '+(m%60)+'m';if(m>0)return 'Ends in '+m+'m '+(s%60)+'s';return 'Ends in '+s+'s'}
function find(id){return document.querySelector((mode==='v1'?'li.lot':'article.tile')+'[data-lot="'+id+'"]')}
function pulse(el,cls,ms){el.classList.remove(cls);void el.offsetWidth;el.classList.add(cls);setTimeout(function(){el.classList.remove(cls)},ms)}
function setText(el,sel,text){var target=el.querySelector(sel);if(target)target.textContent=text}
function updateLot(lot){var el=find(lot.id);if(!el)return;
if(mode==='v1'){var bid=el.querySelector('.lot-bid');if(bid&&bid.textContent.charAt(0)==='$')bid.textContent=usd(lot.currentBid)}
else{el.dataset.bid=Number(lot.currentBid).toFixed(2)}
setText(el,mode==='v1'?'.lot-bids':'.tile__bids',bidsLabel(lot.bidCount));pulse(el,'flash',1400)}
function buildLot(lot){var el;if(mode==='v1'){el=document.createElement('li');el.className='lot';
el.innerHTML='<h3 class="lot-title"></h3><span class="lot-bid"></span><span class="lot-bids"></span><time class="lot-ends"></time><p class="lot-description"></p>';
setText(el,'.lot-title',lot.title);setText(el,'.lot-bid',usd(lot.currentBid));setText(el,'.lot-description',lot.description);
var time=el.querySelector('time');time.dateTime=isoSeconds(lot.endsAt);time.textContent=endsLabel(lot.endsAt)}
else{el=document.createElement('article');el.className='tile';el.dataset.bid=Number(lot.currentBid).toFixed(2);el.dataset.currency=lot.currency;el.dataset.ends=isoSeconds(lot.endsAt);
el.innerHTML='<h3 class="tile__title"></h3><div class="tile__meta"><span class="tile__category"></span><span class="tile__bids"></span><span class="tile__ends"></span></div><p class="tile__body"></p>';
setText(el,'.tile__title',lot.title);setText(el,'.tile__body',lot.description);
setText(el,'.tile__category',names[lot.category]||lot.category)}
el.dataset.lot=lot.id;el.dataset.category=lot.category;setText(el,mode==='v1'?'.lot-bids':'.tile__bids',bidsLabel(lot.bidCount));return el}
function getEnds(el){return mode==='v1'?(el.querySelector('time')||{}).dateTime||'':el.dataset.ends||''}
function addLot(lot){if(find(lot.id)||(onlyCategory&&lot.category!==onlyCategory))return;
var list=mode==='v1'?document.querySelector('section.category[data-category="'+lot.category+'"] ul.lot-list'):document.querySelector('main.auction-grid');if(!list)return;
var el=buildLot(lot),ends=isoSeconds(lot.endsAt),before=null;
for(var i=0;i<list.children.length;i++){if(getEnds(list.children[i])>ends){before=list.children[i];break}}
list.insertBefore(el,before);pulse(el,'is-new',5000);changeCount(1)}
function addSold(lot){var list=document.querySelector(mode==='v1'?'ol.sold-list':'.ticker');if(!list)return;
var item=document.createElement(mode==='v1'?'li':'span');
if(mode==='v1'){item.className='sold-item';item.innerHTML='<span class="sold-title"></span><span class="sold-price"></span>';
setText(item,'.sold-title',lot.title);setText(item,'.sold-price','Sold '+usd(lot.soldPrice))}
else{item.className='ticker__item';item.textContent=lot.title+' \\u00b7 '+usd(lot.soldPrice)}
list.insertBefore(item,list.firstChild);pulse(item,'is-new',3000);while(list.children.length>MAX_SOLD)list.removeChild(list.lastChild);
var empty=document.querySelector('.sold-empty');if(empty)empty.remove()}
function sellLot(lot){var el=find(lot.id);if(el){el.classList.add('is-sold');el.dataset.soldPrice=usd(lot.soldPrice);
setTimeout(function(){el.remove()},2600);changeCount(-1)}addSold(lot)}
function changeCount(delta){var stat=document.querySelector('.stat-open');if(stat)stat.textContent=String(Number(stat.textContent)+delta)}
setInterval(function(){var now=Date.now();
document.querySelectorAll(mode==='v1'?'li.lot':'article.tile').forEach(function(el){var ends=getEnds(el);if(!ends)return;
var left=new Date(ends)-now;el.classList.toggle('ending',left<60000);
if(mode==='v1')setText(el,'time.lot-ends',endsLabel(ends));else setText(el,'.tile__ends',endsLabel(ends))})},1000);
function connect(){var socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
socket.onopen=function(){indicator.classList.add('on');indicator.textContent='Live'};
socket.onclose=function(){indicator.classList.remove('on');indicator.textContent='Reconnecting';setTimeout(connect,2000)};
socket.onmessage=function(event){var message=JSON.parse(event.data);
if(message.type==='lot')updateLot(message.lot);else if(message.type==='sold')sellLot(message.lot);else if(message.type==='new')addLot(message.lot)}}
connect()})();`;
