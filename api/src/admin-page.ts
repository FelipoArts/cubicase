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
.fb{border-top:1px solid var(--line);padding:10px 0}.fb:first-child{border:0}.fb pre{white-space:pre-wrap;word-break:break-word;font:inherit;margin:6px 0}.pimg{border-radius:8px;object-fit:cover;border:1px solid var(--line)}
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
function api(path,opt){opt=opt||{};opt.headers={Authorization:'Bearer '+token};return fetch(path,opt).then(function(r){if(r.status===401){logout();throw new Error('Token recusado')}if(r.status===429)throw new Error('Muitas tentativas, aguarde um minuto');if(!r.ok)return r.json().catch(function(){return null}).then(function(b){throw new Error((b&&b.message)||('HTTP '+r.status))});return r.json()})}
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

function bars(days,label){
  var max=Math.max.apply(null,days.map(function(d){return d.count}).concat([1])),w=720,h=110,bw=w/days.length,out='<svg viewBox="0 0 '+w+' '+(h+18)+'" width="100%" role="img" aria-label="'+esc(label||'Contas criadas por dia nos últimos 30 dias')+'">';
  days.forEach(function(d,i){var bh=Math.round(d.count/max*h);out+='<rect x="'+(i*bw+2)+'" y="'+(h-bh)+'" width="'+(bw-4)+'" height="'+bh+'" rx="3" fill="var(--bar)"><title>'+esc(d.date)+': '+d.count+'</title></rect>';if(d.count)out+='<text x="'+(i*bw+bw/2)+'" y="'+(h-bh-3)+'" text-anchor="middle">'+d.count+'</text>'});
  out+='<text x="0" y="'+(h+13)+'">'+esc(days[0].date.slice(5))+'</text><text x="'+w+'" y="'+(h+13)+'" text-anchor="end">'+esc(days[days.length-1].date.slice(5))+'</text></svg>';return out
}

var OSNAMES={windows:'Windows',macos:'macOS',linux:'Linux',other:'Outro'};
function installsHtml(i){
  if(!i)return '';if(!i.ok)return sect('Instalações',failed(i));
  var warn=i.nearKvWriteLimit?'<div class="banner warn">⚠ Perto do limite de escritas do KV: hora de agrupar os pings de instalação.</div>':'';
  var vers=i.versions.length?'<div class="scroll"><table><tr><th>Versão</th><th>Instalações ativas (30 dias)</th></tr>'+i.versions.map(function(x){return '<tr><td>'+esc(x.version)+'</td><td>'+n(x.count)+'</td></tr>'}).join('')+'</table></div>':'<p class="muted">Ainda ninguém mandou o ping. Ele vem junto com a próxima versão do app, e o número sobe conforme as pessoas atualizam.</p>';
  var sys=i.systems.length?'<p class="muted">Sistemas: '+i.systems.map(function(x){return esc(OSNAMES[x.os]||x.os)+' '+n(x.count)}).join(' · ')+'</p>':'';
  return warn+sect('Instalações do app','<p>Total: <strong>'+n(i.total)+'</strong> · ativas em 24 h: <strong>'+n(i.active24h)+'</strong> · 7 dias: <strong>'+n(i.active7d)+'</strong> · 30 dias: <strong>'+n(i.active30d)+'</strong></p>'+bars(i.newPerDay,'Novas instalações por dia nos últimos 30 dias')+'<p class="muted">Novas instalações por dia (30 dias). Conta só quem já atualizou para a versão com o ping; o ID é aleatório e não identifica a pessoa.</p>'+vers+sys)
}

function pct(a,b){return b?Math.round(a/b*100)+'%':'—'}
function funnelHtml(o){
  var i=o.installs,d=o.downloads,a=o.accounts,c=o.activation,out='';
  if(i&&i.ok){
    var top=d&&d.ok?d.installers:0,rows=[];
    if(top)rows.push({label:'Baixou o instalador (GitHub)',count:top});
    i.funnel.forEach(function(x){rows.push(x)});
    var base=rows[0].count||1;
    out+=sect('Funil de uso (por instalação)','<div class="scroll"><table><tr><th>Etapa</th><th>Instalações</th><th>Do início</th><th>Da etapa anterior</th></tr>'+rows.map(function(x,k){return '<tr><td>'+esc(x.label)+'</td><td>'+n(x.count)+'</td><td>'+pct(x.count,base)+'</td><td>'+(k?pct(x.count,rows[k-1].count):'—')+'</td></tr>'}).join('')+'</table></div><p class="muted">A maior queda entre duas linhas é onde as pessoas travam. Baixar conta o histórico todo; as demais etapas só contam quem já atualizou para a versão com o ping.</p>');
    if(i.guestFunnel&&i.guestFunnel.length>1)out+=sect('Funil de quem só joga (entra no servidor de um amigo)','<div class="scroll"><table><tr><th>Etapa</th><th>Instalações</th><th>Do início</th><th>Da etapa anterior</th></tr>'+i.guestFunnel.map(function(x,k){return '<tr><td>'+esc(x.label)+'</td><td>'+n(x.count)+'</td><td>'+pct(x.count,i.guestFunnel[0].count||1)+'</td><td>'+(k?pct(x.count,i.guestFunnel[k-1].count):'—')+'</td></tr>'}).join('')+'</table></div><p class="muted">Quem instala só para entrar no servidor de um amigo não aparece no funil de cima (que mede quem hospeda). Só conta quem já atualizou para a versão com estes marcos.</p>');
    out+=sect('Retenção por semana de chegada','<div class="scroll"><table><tr><th>Semana</th><th>Instalações</th><th>Voltou depois de 1 dia</th><th>7 dias</th><th>14 dias</th></tr>'+(i.retention.length?i.retention.map(function(r){function cell(v){return v==null?'<span class="muted">cedo demais</span>':n(v)+' ('+pct(v,r.size)+')'}return '<tr><td>'+esc(r.week)+'</td><td>'+n(r.size)+'</td><td>'+cell(r.d1)+'</td><td>'+cell(r.d7)+'</td><td>'+cell(r.d14)+'</td></tr>'}).join(''):'<tr><td colspan="5">sem dados ainda</td></tr>')+'</table></div>');
    var g=i.gone;
    out+=sect('Sumiram (sem sinal há mais de 14 dias)','<p><strong>'+n(g.total)+'</strong> instalação(ões) · '+pct(g.total,i.total)+' do total</p>'+(g.total?'<div class="scroll"><table><tr><th>Última etapa que alcançaram</th><th>Instalações</th></tr>'+g.byStage.map(function(x){return '<tr><td>'+esc(x.label)+'</td><td>'+n(x.count)+'</td></tr>'}).join('')+'</table></div><p class="muted">Por versão: '+g.byVersion.map(function(x){return esc(x.version)+' '+n(x.count)}).join(' · ')+'</p>':'<p class="muted">Ninguém sumiu ainda (o ping é recente).</p>'));
    out+=sect('Falhas que as instalações encontraram','<div class="scroll"><table><tr><th>Falha</th><th>Instalações</th><th>Dessas, sumiram</th></tr>'+i.errors.map(function(x){return '<tr><td>'+esc(x.label)+'</td><td>'+n(x.installs)+'</td><td>'+n(x.gone)+(x.installs?' ('+pct(x.gone,x.installs)+')':'')+'</td></tr>'}).join('')+'</table></div><p class="muted">Compare com os '+pct(g.total,i.total)+' que sumiram em geral: falha com taxa bem maior é a que mais expulsa. Só o tipo da falha é enviado, nunca o texto.</p>')
  }
  if(c&&c.ok&&a&&a.ok){
    var rows2=[['Contas criadas',a.total],['Criaram o perfil',c.withProfile],['Colocaram um servidor na biblioteca (host)',c.hosts],['Parearam um computador (painel web)',c.withDevice],['Assinam o Plus',c.plus]];
    out+=sect('Contas: até onde chegaram','<div class="scroll"><table><tr><th>Etapa</th><th>Contas</th><th>Das contas</th></tr>'+rows2.map(function(x){return '<tr><td>'+esc(x[0])+'</td><td>'+n(x[1])+'</td><td>'+pct(x[1],a.total)+'</td></tr>'}).join('')+'</table></div><p class="muted">O Cubicase funciona sem conta, então quem não aparece aqui pode estar usando normalmente.</p>');
    var sv=o.servers;
    out+=sect('Servidores e convidados','<p>Servidores criados: <strong>'+n(sv&&sv.ok?sv.registered:0)+'</strong> · que já tiveram convidado: <strong>'+n(c.serversWithGuest)+'</strong>'+(sv&&sv.ok&&sv.registered?' ('+pct(c.serversWithGuest,sv.registered)+')':'')+'</p><p class="muted">Servidor que nunca recebe convidado é onde o convite pode estar falhando.</p>')
  }
  return out
}

function overviewHtml(o){
  var d=o.downloads,a=o.accounts,s=o.subscriptions,v=o.servers,html='<div class="grid">';
  var ins=o.installs;
  html+=kpi(ins&&ins.ok?n(ins.total):'—','instalações (únicas, com o ping da versão nova)');
  html+=kpi(ins&&ins.ok?n(ins.active7d):'—','ativas nos últimos 7 dias'+(ins&&ins.ok?' · 24 h: '+n(ins.active24h):''));
  html+=kpi(d.ok?n(d.installers):'—','downloads do instalador');
  html+=kpi(a.ok?n(a.total):'—','contas criadas'+(a.ok?' · +'+n(a.last24h)+' em 24 h':''));
  html+=kpi(s.ok?n(s.active):'—','assinantes do Plus');
  html+=kpi(v.ok?n(v.registered):'—','servidores criados');
  html+=kpi(v.ok?n(v.live):'—','servidores com sinal agora');
  html+='</div>';
  html+=installsHtml(ins);
  html+=funnelHtml(o);
  html+=a.ok?sect('Contas novas por dia (30 dias)',bars(a.perDay)+'<p class="muted">7 dias: '+n(a.last7d)+' · 30 dias: '+n(a.last30d)+'</p>'):sect('Contas',failed(a));
  html+=a.ok?sect('Contas mais recentes','<div class="scroll"><table><tr><th>E-mail</th><th>Criada</th><th>Último acesso</th><th>Entrou com</th></tr>'+a.recent.map(function(u){return '<tr><td>'+esc(u.email)+'</td><td>'+esc(when(u.createdAt))+'</td><td>'+esc(ago(u.lastSignIn))+'</td><td>'+esc(u.provider)+'</td></tr>'}).join('')+'</table></div>'):'';
  html+=d.ok?sect('Versões publicadas (última: '+esc(d.latest||'—')+')','<div class="scroll"><table><tr><th>Versão</th><th>Publicada</th><th>Downloads</th><th>Checagens</th></tr>'+d.releases.map(function(x){return '<tr><td>'+esc(x.tag)+'</td><td>'+esc(when(x.publishedAt))+'</td><td>'+n(x.installers)+'</td><td>'+n(x.updateChecks)+'</td></tr>'}).join('')+'</table></div><p class="muted">Contagem do GitHub: baixar pelo site e pelo atualizador do app contam aqui.</p>'):sect('Downloads',failed(d));
  html+=s.ok?sect('Assinaturas','<p>'+Object.keys(s.byStatus).map(function(k){return esc(k)+': <strong>'+n(s.byStatus[k])+'</strong>'}).join(' · ')+(Object.keys(s.byStatus).length?'':'nenhuma ainda')+'</p>'):sect('Assinaturas',failed(s));
  html+=v.ok?sect('Servidores com sinal agora','<p>'+(Object.keys(v.byStatus).length?Object.keys(v.byStatus).map(function(k){return esc(k)+': <strong>'+n(v.byStatus[k])+'</strong>'}).join(' · '):'nenhum')+'</p>'):sect('Servidores',failed(v));
  return html
}

function feedbackHtml(f){
  var items=f.items||[];
  return sect('Suporte — relatos recebidos ('+items.length+')',items.length?items.map(function(x){return '<div class="fb"><strong>'+esc(x.subject)+'</strong> <span class="tag">'+esc(x.category)+'</span>'+(x.emailed?'':' <span class="tag" style="color:var(--bad)">e-mail não saiu</span>')+'<div class="muted">'+esc(x.email)+' · app '+esc(x.appVersion||'?')+' · '+esc(x.os||'?')+' · '+esc(when(x.createdAt))+'</div><pre>'+esc(x.message)+'</pre><a href="mailto:'+encodeURIComponent(x.email)+'?subject='+encodeURIComponent('Re: '+x.subject)+'">Responder</a> · <button data-del="'+esc(x.id)+'">Resolvido (apagar)</button></div>'}).join(''):'<p class="muted">Nenhum relato guardado. Eles ficam 120 dias e só aparecem aqui depois do deploy desta versão.</p>')
}

var REASONS={image:'Imagem imprópria',name_or_bio:'Nome ou bio ofensiva',other:'Outro motivo'};
function reportsHtml(r){
  var items=r.items||[];
  return sect('Denúncias de perfil ('+items.length+')',items.length?items.map(function(x){
    var t=x.target,imgs='';
    if(t&&t.avatarHash)imgs+='<img class="pimg" src="/api/v1/profile-image/'+esc(t.avatarHash)+'" alt="Foto" width="64" height="64">';
    if(t&&t.bannerHash)imgs+='<img class="pimg" src="/api/v1/profile-image/'+esc(t.bannerHash)+'" alt="Banner" width="192" height="64">';
    var who=t?'<strong>'+esc(t.displayName)+'</strong>'+(t.bio?'<div class="muted">Bio: '+esc(t.bio)+'</div>':''):'<span class="muted">Perfil já apagado pela pessoa</span>';
    var btns=t?('<button data-rep="'+esc(x.id)+'" data-act="clear_images">Remover imagens</button> <button data-rep="'+esc(x.id)+'" data-act="clear_bio">Remover bio</button> <button data-rep="'+esc(x.id)+'" data-act="rename">Trocar nome</button> '):'';
    return '<div class="fb">'+who+' <span class="tag">'+esc(REASONS[x.reason]||x.reason)+'</span>'+(x.openForTarget>1?' <span class="tag" style="color:var(--bad)">'+x.openForTarget+' denúncias</span>':'')+'<div class="muted">servidor '+esc(x.serverShortCode||'?')+' · '+esc(when(x.createdAt))+'</div>'+(x.note?'<pre>'+esc(x.note)+'</pre>':'')+(imgs?'<div style="margin:8px 0;display:flex;gap:8px;flex-wrap:wrap">'+imgs+'</div>':'')+btns+'<button data-rep="'+esc(x.id)+'" data-act="dismiss">Arquivar (sem ação)</button></div>'
  }).join(''):'<p class="muted">Nenhuma denúncia aberta.</p>')
}

function bannerReportsHtml(r){
  var items=r.items||[];
  return sect('Denúncias de banner de servidor ('+items.length+')',items.length?items.map(function(x){
    var img=x.bannerHash?'<img class="pimg" src="/api/v1/servers/'+esc(x.serverShortCode)+'/banner?v='+esc(x.bannerHash)+'" alt="Banner" width="288" height="96">':'<span class="muted">Sem banner agora</span>';
    var btns=x.current?'<button data-brep="'+esc(x.id)+'" data-act="remove_banner">Remover banner</button> ':'';
    return '<div class="fb"><strong>'+esc(x.serverName||x.serverShortCode)+'</strong> <span class="tag">'+esc(REASONS[x.reason]||x.reason)+'</span>'+(x.openForServer>1?' <span class="tag" style="color:var(--bad)">'+x.openForServer+' denúncias</span>':'')+(x.current?'':' <span class="tag">banner já trocado ou removido</span>')+'<div class="muted">servidor '+esc(x.serverShortCode)+' · '+esc(when(x.createdAt))+'</div>'+(x.note?'<pre>'+esc(x.note)+'</pre>':'')+'<div style="margin:8px 0">'+img+'</div>'+btns+'<button data-brep="'+esc(x.id)+'" data-act="dismiss">Arquivar (sem ação)</button></div>'
  }).join(''):'<p class="muted">Nenhuma denúncia aberta.</p>')
}

var ACT_LABELS={grant_plus:'Dar Plus de cortesia',revoke_plus:'Tirar Plus de cortesia',clear_images:'Remover imagens',clear_bio:'Remover bio',rename:'Trocar nome por genérico'};
var ACT_CONFIRM={grant_plus:'Dar Cubicase Plus de cortesia a esta conta?',revoke_plus:'Tirar o Plus de cortesia desta conta?',clear_images:'Remover a foto e o banner deste perfil (apaga os arquivos)?',clear_bio:'Remover a bio deste perfil?',rename:'Trocar o nome deste perfil por um genérico?'};
function auditHtml(a){
  var items=(a&&a.items)||[];
  return sect('Registro de ações do painel ('+items.length+')',items.length?'<div class="scroll"><table><tr><th>Quando</th><th>Ação</th><th>Conta</th><th>Detalhe</th></tr>'+items.map(function(x){return '<tr><td>'+esc(when(x.at))+'</td><td>'+esc(ACT_LABELS[x.action]||x.action)+'</td><td>'+esc(x.label)+'</td><td>'+esc(x.detail||'')+'</td></tr>'}).join('')+'</table></div>':'<p class="muted">Nenhuma ação feita por aqui ainda. Cada ação em uma conta fica registrada neste histórico por 1 ano.</p>')
}
function accountsShell(){
  return sect('Contas — buscar e agir','<form id="acctForm"><input id="acctQ" type="search" autocomplete="off" placeholder="E-mail, nome, @usuário ou ID da conta" aria-label="Buscar conta"><button>Buscar</button></form><div id="acctOut" class="muted" style="margin-top:10px"></div>')
}
function acctList(items){
  if(!items.length)return '<p class="muted">Nenhuma conta encontrada.</p>';
  return '<div class="scroll"><table><tr><th>E-mail</th><th>Nome</th><th>Criada</th><th>Último acesso</th><th></th></tr>'+items.map(function(u){return '<tr><td>'+esc(u.email)+'</td><td>'+esc(u.displayName||'—')+'</td><td>'+esc(when(u.createdAt))+'</td><td>'+esc(ago(u.lastSignIn))+'</td><td><button data-acc="'+esc(u.id)+'">Abrir</button></td></tr>'}).join('')+'</table></div>'
}
var PLANS={monthly:'mensal',annual:'anual'};
function acctDetail(a){
  var p=a.profile,s=a.subscription,imgs='';
  if(p&&p.avatarHash)imgs+='<img class="pimg" src="/api/v1/profile-image/'+esc(p.avatarHash)+'" alt="Foto" width="64" height="64">';
  if(p&&p.bannerHash)imgs+='<img class="pimg" src="/api/v1/profile-image/'+esc(p.bannerHash)+'" alt="Banner" width="192" height="64">';
  var plus=s?(s.status==='active'||s.status==='trialing'?'<span class="tag" style="color:var(--accent)">Plus ativo</span>':'<span class="tag">Plus '+esc(s.status)+'</span>')+' plano '+esc(PLANS[s.plan]||s.plan)+(s.manual?' · <strong>cortesia</strong>':' · Stripe')+(s.periodEnd?' · até '+esc(when(s.periodEnd)):'')+(s.cancelAtPeriodEnd?' · cancela no fim do período':''):'<span class="muted">sem assinatura</span>';
  var btns=[];
  if(!s||(s.manual&&s.status!=='active'))btns.push('grant_plus');
  if(s&&s.manual&&s.status==='active')btns.push('revoke_plus');
  if(p){if(p.avatarHash||p.bannerHash)btns.push('clear_images');if(p.bio)btns.push('clear_bio');btns.push('rename')}
  var b=btns.map(function(k){return '<button data-acc-act="'+k+'" data-id="'+esc(a.id)+'">'+ACT_LABELS[k]+'</button>'}).join(' ');
  return '<div class="fb"><strong>'+esc(a.email)+'</strong> <span class="tag">'+esc(a.provider)+'</span><div class="muted">ID '+esc(a.id)+' · criada '+esc(when(a.createdAt))+' · último acesso '+esc(ago(a.lastSignIn))+'</div>'
  +(p?'<p><strong>'+esc(p.displayName)+'</strong>'+(p.handle?' <span class="muted">@'+esc(p.handle)+'</span>':'')+(p.bio?'<br><span class="muted">Bio: '+esc(p.bio)+'</span>':'')+'</p>'+(imgs?'<div style="margin:8px 0;display:flex;gap:8px;flex-wrap:wrap">'+imgs+'</div>':''):'<p class="muted">Ainda sem perfil.</p>')
  +'<p>'+plus+(a.streak?'<br><span class="muted">Sequência de Plus desde '+esc(when(a.streak.startedAt))+' · ativa até '+esc(when(a.streak.lastActiveEnd))+'</span>':'')+'</p>'
  +'<p class="muted">Computadores pareados: '+(a.devices.length?a.devices.map(function(d){return esc(d.name)+' ('+esc(ago(d.lastSeenAt))+')'}).join(', '):'nenhum')+'<br>Servidores: '+(a.servers.length?a.servers.map(function(m){return esc(m.shortCode)+' ('+esc(m.role)+')'}).join(', '):'nenhum')+'<br>Denúncias de perfil: '+a.reports.open+' aberta(s) · '+a.reports.total+' no total</p>'
  +'<div>'+b+'</div><p class="err" id="acctMsg"></p></div>'
}

var busy=false,shellDone=false;
function load(force){
  if(busy||!token)return;busy=true;$('refresh').disabled=true;var q=force?'?refresh=1':'';
  var app=$('app');
  if(!shellDone||!$('dyn')){app.innerHTML='<div id="acct">'+accountsShell()+'</div><div id="dyn"><p class="muted">Carregando…</p></div>';shellDone=true}
  Promise.all([api('/api/v1/admin/health'+q),api('/api/v1/admin/overview'+q),api('/api/v1/admin/feedback'),api('/api/v1/admin/profile-reports'),api('/api/v1/admin/banner-reports'),api('/api/v1/admin/audit')]).then(function(r){
    $('dyn').innerHTML=healthHtml(r[0])+reportsHtml(r[3])+bannerReportsHtml(r[4])+overviewHtml(r[1])+auditHtml(r[5])+feedbackHtml(r[2]);$('stamp').textContent='Atualizado às '+new Date().toLocaleTimeString('pt-BR')
  }).catch(function(e){if(token&&$('dyn'))$('dyn').innerHTML='<p class="err">'+esc(e.message)+'</p>'}).then(function(){busy=false;$('refresh').disabled=false})
}
function openAccount(id){
  var out=$('acctOut');out.innerHTML='Carregando…';
  api('/api/v1/admin/accounts/'+id).then(function(r){out.innerHTML=acctDetail(r.account)}).catch(function(err){out.innerHTML='<span class="err">'+esc(err.message)+'</span>'})
}
$('loginForm').addEventListener('submit',function(e){e.preventDefault();var t=$('tok').value.trim();if(!t)return;token=t;$('loginErr').textContent='';
  api('/api/v1/admin/health').then(function(){try{sessionStorage.setItem('cubicase-admin',t)}catch(e){}$('tok').value='';show();load(false)}).catch(function(err){token=null;$('loginErr').textContent=err.message})});
$('refresh').addEventListener('click',function(){load(true)});
$('logout').addEventListener('click',function(){$('app').innerHTML='';logout()});
$('app').addEventListener('submit',function(e){
  if(!e.target||e.target.id!=='acctForm')return;e.preventDefault();
  var qv=$('acctQ').value.trim(),out=$('acctOut');if(qv.length<2){out.textContent='Digite pelo menos 2 caracteres.';return}
  out.textContent='Buscando…';
  api('/api/v1/admin/accounts?q='+encodeURIComponent(qv)).then(function(r){out.innerHTML=acctList(r.items||[])}).catch(function(err){out.innerHTML='<span class="err">'+esc(err.message)+'</span>'})
});
$('app').addEventListener('click',function(e){
  var accId=e.target&&e.target.getAttribute&&e.target.getAttribute('data-acc');
  if(accId){openAccount(accId);return}
  var accAct=e.target&&e.target.getAttribute&&e.target.getAttribute('data-acc-act');
  if(accAct){var uid=e.target.getAttribute('data-id');if(!confirm(ACT_CONFIRM[accAct]||'Confirmar?'))return;
    api('/api/v1/admin/accounts/'+uid+'/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:accAct})}).then(function(){openAccount(uid);load(false)}).catch(function(err){var m=$('acctMsg');if(m)m.textContent=err.message});return}
  var rep=e.target&&e.target.getAttribute&&e.target.getAttribute('data-rep');
  if(rep){var act=e.target.getAttribute('data-act'),labels={clear_images:'Remover as imagens deste perfil?',clear_bio:'Remover a bio deste perfil?',rename:'Trocar o nome deste perfil por um genérico?',dismiss:'Arquivar a denúncia sem ação?'};
    if(!confirm(labels[act]||'Confirmar?'))return;
    api('/api/v1/admin/profile-reports/'+rep+'/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:act})}).then(function(){load(false)}).catch(function(err){alert(err.message)});return}
  var brep=e.target&&e.target.getAttribute&&e.target.getAttribute('data-brep');
  if(brep){var bact=e.target.getAttribute('data-act');
    if(!confirm(bact==='remove_banner'?'Remover o banner deste servidor?':'Arquivar a denúncia sem ação?'))return;
    api('/api/v1/admin/banner-reports/'+brep+'/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:bact})}).then(function(){load(false)}).catch(function(err){alert(err.message)});return}
  var id=e.target&&e.target.getAttribute&&e.target.getAttribute('data-del');if(!id||!confirm('Apagar este relato do painel?'))return;api('/api/v1/admin/feedback/'+id,{method:'DELETE'}).then(function(){load(false)})});
setInterval(function(){if(!document.hidden)load(false)},60000);
show();if(token)load(false);
})();
</script>
</body>
</html>`;
