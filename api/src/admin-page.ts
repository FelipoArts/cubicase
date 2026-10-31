// Página do painel do dono (/admin). Sem dado nenhum embutido: o token é digitado na página e só vai nas chamadas à API
// (/api/v1/admin/*). O JavaScript abaixo evita crases e ${} de propósito, porque vive dentro de um template literal.
export const ADMIN_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Cubicase — painel do dono</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#14171c;--muted:#5d6672;--line:#e3e6ea;--accent:#2f7d4f;--bad:#c0392b;--warn:#b7791f;--bar:#3b82b6}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--card:#171b21;--ink:#e8ebef;--muted:#99a3af;--line:#262c34;--accent:#4cc27f;--bad:#ef6a5a;--warn:#e0a23b;--bar:#5aa7d8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px}
header{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between;margin-bottom:16px}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:0 0 10px}
.muted{color:var(--muted);font-size:13px}
button{font:inherit;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer}
button:hover{border-color:var(--muted)}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
.grid .card{margin:0}.kpi{font-size:26px;font-weight:650;line-height:1.1}.kpi small{font-size:12px;font-weight:400;color:var(--muted);display:block;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
.scroll{overflow-x:auto}
.row{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)}.row:last-child{border:0}
.dot{width:10px;height:10px;border-radius:50%;flex:none}.ok{background:var(--accent)}.down{background:var(--bad)}.unk{background:var(--warn)}
.tag{font-size:12px;border:1px solid var(--line);border-radius:6px;padding:1px 6px;color:var(--muted)}
.banner{border-radius:12px;padding:12px 14px;margin-bottom:12px;font-weight:600;border:1px solid var(--line);background:var(--card)}
.banner.ok{border-color:var(--accent)}.banner.bad{border-color:var(--bad);color:var(--bad)}.banner.warn{border-color:var(--warn);color:var(--warn)}
.err{color:var(--bad);font-size:13px}
.fb{border-top:1px solid var(--line);padding:10px 0}.fb:first-child{border:0}.fb pre{white-space:pre-wrap;word-break:break-word;font:inherit;margin:6px 0}
form{display:flex;gap:8px;flex-wrap:wrap}input{font:inherit;padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);min-width:260px}
svg text{fill:var(--muted);font-size:10px}
</style>
</head>
<body>
<main>
<header><h1>Cubicase — painel do dono</h1><div><span class="muted" id="stamp"></span> <button id="refresh" hidden>Atualizar agora</button> <button id="logout" hidden>Sair</button></div></header>
<div id="login" hidden><div class="card"><h2>Acesso restrito</h2><form id="loginForm"><input id="tok" type="password" autocomplete="off" placeholder="Token do painel" aria-label="Token do painel"><button>Entrar</button></form><p class="err" id="loginErr"></p></div></div>
<div id="app" hidden></div>
</main>
<script>
(function(){
var $=function(i){return document.getElementById(i)};
var token=null;try{token=sessionStorage.getItem('cubicase-admin')}catch(e){}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function n(v){return Number(v||0).toLocaleString('pt-BR')}
function bytes(b){var u=['B','KB','MB','GB','TB'],i=0;b=Number(b||0);while(b>=1024&&i<4){b/=1024;i++}return b.toLocaleString('pt-BR',{maximumFractionDigits:i?1:0})+' '+u[i]}
function ago(iso){if(!iso)return '—';var s=(Date.now()-Date.parse(iso))/1000;if(s<90)return 'agora';if(s<5400)return Math.round(s/60)+' min atrás';if(s<172800)return Math.round(s/3600)+' h atrás';return Math.round(s/86400)+' dias atrás'}
function when(iso){return iso?new Date(iso).toLocaleString('pt-BR'):'—'}
function api(path,opt){opt=opt||{};opt.headers={Authorization:'Bearer '+token};return fetch(path,opt).then(function(r){if(r.status===401){logout();throw new Error('Token recusado')}if(r.status===429)throw new Error('Muitas tentativas, aguarde um minuto');if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})}
function logout(){try{sessionStorage.removeItem('cubicase-admin')}catch(e){}token=null;show()}
function show(){var on=!!token;$('login').hidden=on;$('app').hidden=!on;$('refresh').hidden=!on;$('logout').hidden=!on}
function sect(title,body){return '<div class="card"><h2>'+title+'</h2>'+body+'</div>'}
function failed(s){return '<p class="err">Não consegui carregar: '+esc(s.error)+'</p>'}
function kpi(v,l){return '<div class="card"><div class="kpi">'+v+'<small>'+l+'</small></div></div>'}

function healthHtml(h){
  if(!h||!h.state)return '<div class="banner warn">Ainda sem checagens guardadas. A rotina roda a cada 5 minutos; use “Atualizar agora”.</div>';
  var st=h.state,ids=Object.keys(st.checks),down=ids.filter(function(i){return !st.checks[i].ok});
  var stale=(Date.parse(h.now)-Date.parse(st.cronAt))>15*60000;
  var b=down.length?'<div class="banner bad">🔴 '+down.length+' serviço(s) fora do ar</div>':stale?'<div class="banner warn">⚠ A rotina de checagem não roda há '+esc(ago(st.cronAt).replace(' atrás',''))+' — confira o Worker</div>':'<div class="banner ok">✅ Tudo funcionando · última checagem '+esc(ago(st.cronAt))+'</div>';
  var rows=ids.map(function(i){var c=st.checks[i];return '<div class="row"><span class="dot '+(c.ok?'ok':'down')+'" aria-hidden="true"></span><div style="flex:1"><strong>'+esc(c.label)+'</strong> <span class="tag">'+(c.ok?'no ar':'fora do ar')+'</span><div class="muted">'+esc(c.detail)+' · '+esc(c.ms)+' ms · desde '+esc(when(c.since))+(c.fails&&c.ok?' · '+c.fails+' falha(s) seguida(s)':'')+'</div></div></div>'}).join('');
  var ev=(st.events||[]).slice(0,10).map(function(e){return '<tr><td>'+esc(when(e.at))+'</td><td>'+(e.ok?'voltou':'caiu')+'</td><td>'+esc(e.label)+'</td><td>'+esc(e.detail)+'</td></tr>'}).join('');
  return b+sect('Serviços',rows)+(ev?sect('Últimas quedas e recuperações','<div class="scroll"><table><tr><th>Quando</th><th>O quê</th><th>Serviço</th><th>Detalhe</th></tr>'+ev+'</table></div>'):'');
}

function bars(days){
  var max=Math.max.apply(null,days.map(function(d){return d.count}).concat([1])),w=720,h=110,bw=w/days.length,out='<svg viewBox="0 0 '+w+' '+(h+18)+'" width="100%" role="img" aria-label="Contas criadas por dia nos últimos 30 dias">';
  days.forEach(function(d,i){var bh=Math.round(d.count/max*h);out+='<rect x="'+(i*bw+2)+'" y="'+(h-bh)+'" width="'+(bw-4)+'" height="'+bh+'" rx="3" fill="var(--bar)"><title>'+esc(d.date)+': '+d.count+'</title></rect>';if(d.count)out+='<text x="'+(i*bw+bw/2)+'" y="'+(h-bh-3)+'" text-anchor="middle">'+d.count+'</text>'});
  out+='<text x="0" y="'+(h+13)+'">'+esc(days[0].date.slice(5))+'</text><text x="'+w+'" y="'+(h+13)+'" text-anchor="end">'+esc(days[days.length-1].date.slice(5))+'</text></svg>';return out
}

function overviewHtml(o){
  var d=o.downloads,a=o.accounts,s=o.subscriptions,v=o.servers,r=o.relay,html='<div class="grid">';
  html+=kpi(d.ok?n(d.installers):'—','downloads do instalador');
  html+=kpi(d.ok?n(d.updateChecks):'—','checagens de atualização (≈ instalações)');
  html+=kpi(a.ok?n(a.total):'—','contas criadas'+(a.ok?' · +'+n(a.last24h)+' em 24 h':''));
  html+=kpi(s.ok?n(s.active):'—','assinantes do Plus');
  html+=kpi(v.ok?n(v.registered):'—','servidores criados');
  html+=kpi(v.ok?n(v.live):'—','servidores com sinal agora');
  html+=kpi(r.ok?bytes(r.totalBytes):'—','relay em '+(r.ok?esc(r.month):'—'));
  html+='</div>';
  html+=a.ok?sect('Contas novas por dia (30 dias)',bars(a.perDay)+'<p class="muted">7 dias: '+n(a.last7d)+' · 30 dias: '+n(a.last30d)+'</p>'):sect('Contas',failed(a));
  html+=a.ok?sect('Contas mais recentes','<div class="scroll"><table><tr><th>E-mail</th><th>Criada</th><th>Último acesso</th><th>Entrou com</th></tr>'+a.recent.map(function(u){return '<tr><td>'+esc(u.email)+'</td><td>'+esc(when(u.createdAt))+'</td><td>'+esc(ago(u.lastSignIn))+'</td><td>'+esc(u.provider)+'</td></tr>'}).join('')+'</table></div>'):'';
  html+=d.ok?sect('Versões publicadas (última: '+esc(d.latest||'—')+')','<div class="scroll"><table><tr><th>Versão</th><th>Publicada</th><th>Downloads</th><th>Checagens</th></tr>'+d.releases.map(function(x){return '<tr><td>'+esc(x.tag)+'</td><td>'+esc(when(x.publishedAt))+'</td><td>'+n(x.installers)+'</td><td>'+n(x.updateChecks)+'</td></tr>'}).join('')+'</table></div><p class="muted">Contagem do GitHub: baixar pelo site e pelo atualizador do app contam aqui.</p>'):sect('Downloads',failed(d));
  html+=s.ok?sect('Assinaturas','<p>'+Object.keys(s.byStatus).map(function(k){return esc(k)+': <strong>'+n(s.byStatus[k])+'</strong>'}).join(' · ')+(Object.keys(s.byStatus).length?'':'nenhuma ainda')+'</p>'):sect('Assinaturas',failed(s));
  html+=v.ok?sect('Servidores com sinal agora','<p>'+(Object.keys(v.byStatus).length?Object.keys(v.byStatus).map(function(k){return esc(k)+': <strong>'+n(v.byStatus[k])+'</strong>'}).join(' · '):'nenhum')+'</p>'):sect('Servidores',failed(v));
  html+=r.ok?sect('Relay — maiores consumidores do mês','<div class="scroll"><table><tr><th>Servidor</th><th>Tráfego</th></tr>'+(r.top.length?r.top.map(function(x){return '<tr><td>'+esc(x.shortCode)+'</td><td>'+bytes(x.bytes)+'</td></tr>'}).join(''):'<tr><td colspan="2">sem consumo</td></tr>')+'</table></div><p class="muted">'+n(r.servers)+' servidor(es) usaram o relay neste mês.</p>'):sect('Relay',failed(r));
  return html
}

function feedbackHtml(f){
  var items=f.items||[];
  return sect('Suporte — relatos recebidos ('+items.length+')',items.length?items.map(function(x){return '<div class="fb"><strong>'+esc(x.subject)+'</strong> <span class="tag">'+esc(x.category)+'</span>'+(x.emailed?'':' <span class="tag" style="color:var(--bad)">e-mail não saiu</span>')+'<div class="muted">'+esc(x.email)+' · app '+esc(x.appVersion||'?')+' · '+esc(x.os||'?')+' · '+esc(when(x.createdAt))+'</div><pre>'+esc(x.message)+'</pre><a href="mailto:'+encodeURIComponent(x.email)+'?subject='+encodeURIComponent('Re: '+x.subject)+'">Responder</a> · <button data-del="'+esc(x.id)+'">Resolvido (apagar)</button></div>'}).join(''):'<p class="muted">Nenhum relato guardado. Eles ficam 120 dias e só aparecem aqui depois do deploy desta versão.</p>')
}

var busy=false;
function load(force){
  if(busy||!token)return;busy=true;$('refresh').disabled=true;var q=force?'?refresh=1':'';
  var app=$('app');if(!app.innerHTML)app.innerHTML='<p class="muted">Carregando…</p>';
  Promise.all([api('/api/v1/admin/health'+q),api('/api/v1/admin/overview'+q),api('/api/v1/admin/feedback')]).then(function(r){
    app.innerHTML=healthHtml(r[0])+overviewHtml(r[1])+feedbackHtml(r[2]);$('stamp').textContent='Atualizado às '+new Date().toLocaleTimeString('pt-BR')
  }).catch(function(e){if(token)app.innerHTML='<p class="err">'+esc(e.message)+'</p>'}).then(function(){busy=false;$('refresh').disabled=false})
}
$('loginForm').addEventListener('submit',function(e){e.preventDefault();var t=$('tok').value.trim();if(!t)return;token=t;$('loginErr').textContent='';
  api('/api/v1/admin/health').then(function(){try{sessionStorage.setItem('cubicase-admin',t)}catch(e){}$('tok').value='';show();load(false)}).catch(function(err){token=null;$('loginErr').textContent=err.message})});
$('refresh').addEventListener('click',function(){load(true)});
$('logout').addEventListener('click',function(){$('app').innerHTML='';logout()});
$('app').addEventListener('click',function(e){var id=e.target&&e.target.getAttribute&&e.target.getAttribute('data-del');if(!id||!confirm('Apagar este relato do painel?'))return;api('/api/v1/admin/feedback/'+id,{method:'DELETE'}).then(function(){load(false)})});
setInterval(function(){if(!document.hidden)load(false)},60000);
show();if(token)load(false);
})();
</script>
</body>
</html>`;
