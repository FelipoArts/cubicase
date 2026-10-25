// Gera as páginas de texto longo do site (docs/): política de privacidade, termos de uso, licenças
// de terceiros e a página do bot do Discord — em português (/privacidade/, /termos/, /licencas/, /discord/)
// e inglês (/en/privacy/, /en/terms/, /en/licenses/, /en/discord/).
//
//   node scripts/build-legal-pages.mjs
//
// O texto mora AQUI (uma fonte só para PT e EN) e as páginas são geradas, então ao mudar
// uma política basta editar este arquivo e rodar o script. As páginas não passam pelo
// dicionário do site (scripts/site-i18n.mjs): cada idioma tem o seu texto, escrito à mão.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "docs");
const UPDATED = { pt: "25 de outubro de 2026", en: "October 25, 2026" };
const EMAIL = "felipe@cubicase.net";
const MAIL = `<a href="mailto:${EMAIL}">${EMAIL}</a>`;

const NAV = {
  pt: { features: "Recursos", how: "Como funciona", tutorial: "Tutorial", signin: "Entrar", download: "Baixar", home: "/", tutorialHref: "/tutorial/", downloadHref: "/download/", menu: "Abrir menu", footerHome: "Início" },
  en: { features: "Features", how: "How it works", tutorial: "Tutorial", signin: "Sign in", download: "Download", home: "/en/", tutorialHref: "/en/tutorial/", downloadHref: "/en/download/", menu: "Open menu", footerHome: "Home" },
};
const FOOTER = {
  pt: { discord: ["Discord", "/discord/"], privacy: ["Privacidade", "/privacidade/"], terms: ["Termos", "/termos/"], licenses: ["Licenças", "/licencas/"],
    disclaimer: "O Cubicase é um projeto independente e não é afiliado, associado nem endossado pela Mojang Studios nem pela Microsoft. Minecraft é uma marca registrada da Mojang Synergies AB." },
  en: { discord: ["Discord", "/en/discord/"], privacy: ["Privacy", "/en/privacy/"], terms: ["Terms", "/en/terms/"], licenses: ["Licenses", "/en/licenses/"],
    disclaimer: "Cubicase is an independent project and is not affiliated with, associated with or endorsed by Mojang Studios or Microsoft. Minecraft is a registered trademark of Mojang Synergies AB." },
};

// ============================================================
// Conteúdo
// ============================================================
const PAGES = {
  privacy: {
    paths: { pt: "/privacidade/", en: "/en/privacy/" },
    pt: {
      title: "Política de Privacidade — Cubicase",
      desc: "Quais dados o Cubicase trata, para quê, com quem são compartilhados e como exercer seus direitos (LGPD).",
      h1: "Política de Privacidade",
      lead: "Resumo: o Cubicase funciona sem conta, não tem anúncios e não usa ferramentas de análise de comportamento. Seu servidor e seus mundos ficam no seu computador. Abaixo está tudo o que passa pela nossa infraestrutura, e por quê.",
      sections: [
        ["1. Quem é o responsável", `<p>O <strong>Cubicase</strong> é um projeto independente, desenvolvido e operado no Brasil (“nós”). Somos o controlador dos dados descritos aqui, nos termos da Lei Geral de Proteção de Dados (LGPD, Lei 13.709/2018).</p>
<p>Contato sobre privacidade e exercício de direitos: pela <strong>Central de Ajuda dentro do app</strong> (Ajuda → Enviar mensagem) ou pelo e-mail ${MAIL}.</p>`],
        ["2. O que fica só no seu computador", `<p>Servidores, mundos, backups, mods, configurações do app, registros técnicos do app (<code>cubeforge_debug.log</code>) e o segredo de dono dos seus servidores ficam em pastas do seu computador (Documentos/CubicaseServers, a pasta de backups — por padrão Documentos/CubicaseBackups, ou a que você escolher nas Configurações — e a pasta de dados do app). <strong>Não enviamos esses arquivos</strong> para nós. Os registros técnicos só saem do seu computador se você os copiar e enviar em um pedido de ajuda.</p>`],
        ["3. Dados que tratamos e por quê", `<table>
<thead><tr><th>Situação</th><th>Dados</th><th>Finalidade</th></tr></thead>
<tbody>
<tr><td><strong>Usar o app (sem conta)</strong></td><td>Um identificador aleatório da instalação (não é seu nome nem e-mail); versão do app; o endereço IP da sua conexão (visto pela infraestrutura, usado por até ~1 minuto para limitar abuso).</td><td>Fazer o serviço funcionar e protegê-lo contra abuso.</td></tr>
<tr><td><strong>Registrar um servidor para convidar amigos</strong></td><td>Código de convite, nome do servidor, versão do Minecraft, tipo/loader, descrição, estado (online/offline), quantidade de jogadores online e se o host está conectado. Se você usa o Radmin VPN como plano B, também o seu endereço nessa rede (faixa 26.x.x.x) e a porta do servidor, enquanto ele está ligado. O segredo de dono é guardado só como <em>hash</em>.</td><td>Permitir que seus amigos encontrem e entrem no servidor.</td></tr>
<tr><td><strong>Entrar como convidado</strong></td><td>O código digitado; identificador da instalação; credenciais temporárias de conexão (válidas por até 24 horas).</td><td>Conectar você ao servidor do host.</td></tr>
<tr><td><strong>Conexão entre host e convidados</strong></td><td>Para ligar os computadores, o app troca endereços de rede (o endereço IP público e os endereços locais de cada um) por uma sala de sinalização temporária no nosso servidor. <strong>Na conexão direta, host e convidados passam a ver o endereço IP uns dos outros</strong>, o que é inerente a esse tipo de conexão; o modo privado (Cubicase Plus) esconde o IP do host. Quando a conexão direta não é possível, o tráfego passa por um servidor de reserva, que repassa dados já cifrados e registra o volume repassado por servidor.</td><td>Conectar host e convidados e medir a cota mensal do servidor de reserva.</td></tr>
<tr><td><strong>Conta (opcional)</strong></td><td>E-mail e, se você entrar com Google ou Discord, o nome e a foto do perfil informados por eles.</td><td>Autenticar e liberar recursos da conta.</td></tr>
<tr><td><strong>Cubicase Plus</strong></td><td>Identificador do cliente e da assinatura na Stripe, plano, situação e data de renovação. <strong>Não recebemos nem guardamos dados de cartão</strong>; o pagamento é feito na página da Stripe.</td><td>Cobrar e liberar os recursos pagos.</td></tr>
<tr><td><strong>Painel web remoto (Plus)</strong></td><td>Nome do computador, token do dispositivo, último acesso, contas convidadas e permissões. Enquanto o app está conectado: estado do servidor, lista de servidores, jogadores online, métricas de uso do computador e as últimas ~200 linhas do console, além dos comandos enviados pelo painel. Esse conteúdo temporário é apagado quando o app se desconecta.</td><td>Controlar o servidor pelo navegador.</td></tr>
<tr><td><strong>Notificações do painel instalado (Plus)</strong></td><td>O endereço da inscrição de notificações do seu navegador ou celular, as chaves públicas dela e as suas preferências (quais avisos receber e o idioma). Enviamos avisos como “fulano entrou”, “servidor ligou” ou “computador offline” por esse endereço.</td><td>Avisar você, no celular ou no navegador, do que acontece no servidor.</td></tr>
<tr><td><strong>Bot do Discord (opcional)</strong></td><td>Quando você liga um Discord ao seu servidor: o identificador do servidor do Discord e do servidor Cubicase ligados, os identificadores dos canais e do cargo de operador escolhidos, o idioma e as preferências de aviso, e as mensagens que o bot publica. <strong>Nomes dos jogadores online</strong> são enviados pelo app à central apenas enquanto há um Discord ligado ao servidor, servem só para avisar quem entrou e saiu, e somem em poucos minutos junto com o estado do servidor. Ao usar um comando de controle, o identificador de quem o usou fica guardado por cerca de 1 minuto (intervalo entre comandos), e o nome exibido dessa pessoa aparece no aviso do canal e no console do host. O Discord vê o que o bot publica e os comandos digitados lá, conforme a política do próprio Discord.</td><td>Mostrar status e avisos no Discord e permitir controlar o servidor por lá (controle, vários Discords e backup fazem parte do Plus).</td></tr>
<tr><td><strong>Link e endereço personalizados (Plus)</strong></td><td>O nome escolhido, associado ao seu servidor e à sua conta.</td><td>Exibir o link/endereço que você configurou.</td></tr>
<tr><td><strong>Central de Ajuda</strong></td><td>O e-mail, o assunto e a mensagem que você escrever, mais a versão do app e o sistema operacional.</td><td>Responder ao seu pedido.</td></tr>
<tr><td><strong>Doações</strong></td><td>Valor e moeda confirmados pela Stripe. Não guardamos seus dados de pagamento.</td><td>Registrar o apoio recebido.</td></tr>
</tbody></table>`],
        ["4. Com quem compartilhamos (operadores e terceiros)", `<p>Não vendemos dados e não exibimos publicidade. Usamos estes prestadores para entregar o serviço; cada um trata os dados conforme a própria política:</p>
<ul>
<li><strong>Cloudflare</strong> — API do Cubicase, armazenamento dos registros de servidor e do painel remoto.</li>
<li><strong>Supabase</strong> — contas, assinaturas e dados do painel remoto.</li>
<li><strong>Stripe</strong> — pagamentos (assinaturas e doações).</li>
<li><strong>Discord</strong> — plataforma onde o bot do Cubicase publica mensagens e recebe comandos, apenas nos servidores do Discord em que você o adicionou. O Discord trata esses dados conforme a política dele.</li>
<li><strong>Serviços de notificação dos navegadores (Google, Apple, Mozilla, Microsoft)</strong> — entregam as notificações do painel instalado; recebem o aviso (já cifrado) e o endereço da inscrição.</li>
<li><strong>Resend</strong> — envio dos e-mails da Central de Ajuda até nós.</li>
<li><strong>Oracle Cloud</strong> — servidor de reserva (relay) em São Paulo, usado só quando a conexão direta não é possível; vê os endereços IP de quem o usa e o volume repassado, mas não o conteúdo (a conexão é cifrada).</li>
<li><strong>Radmin VPN (Famatech)</strong> — programa independente que você pode instalar como plano B de conexão. O Cubicase não envia dados a ele: apenas verifica neste computador se está instalado e conectado e, se você pedir, o instala pelo winget da Microsoft. O uso do Radmin segue a política dele; o tráfego do jogo nesse modo passa pela rede do Radmin, não por nós.</li>
<li><strong>Google (servidores STUN)</strong> — usados para descobrir o endereço IP público necessário à conexão direta; o Google vê o IP de quem consulta.</li>
<li><strong>GitHub</strong> — hospedagem do site e dos instaladores/atualizações do app (o app consulta as versões publicadas).</li>
<li><strong>Mojang/Microsoft, Adoptium, PaperMC, Forge/NeoForge, Fabric</strong> — de onde o app baixa o servidor, o Java e os instaladores; eles enxergam o IP de quem baixa.</li>
<li><strong>Modrinth e CurseForge</strong> — busca e download de mods; recebem os termos pesquisados e, para identificar mods, o código hash dos arquivos (nunca os arquivos).</li>
<li><strong>Google Fonts</strong> — fontes das páginas do site (o Google vê o IP de quem abre as páginas).</li>
</ul>
<p>Também podemos divulgar dados se houver obrigação legal ou ordem de autoridade competente.</p>`],
        ["5. Bases legais (LGPD, art. 7º)", `<p><strong>Execução de contrato</strong> (fornecer o app e os recursos que você pediu, inclusive a assinatura), <strong>legítimo interesse</strong> (segurança, prevenção de abuso e fraude, e o funcionamento básico da rede) e <strong>cumprimento de obrigação legal</strong> (por exemplo, registros fiscais da assinatura). Quando exigido, pedimos o seu <strong>consentimento</strong>, que você pode revogar a qualquer momento.</p>`],
        ["6. Por quanto tempo guardamos", `<ul>
<li>Credenciais e sessões de conexão: expiram em até 24 horas.</li>
<li>Consumo mensal do servidor de reserva (bytes repassados por servidor): até 40 dias.</li>
<li>Contadores anti-abuso por IP: cerca de 1 minuto.</li>
<li>Registro do servidor: até você apagar o servidor no app ou pedir a remoção.</li>
<li>Conta: enquanto existir; você pode pedir a exclusão.</li>
<li>Dados da assinatura: enquanto a assinatura existir e pelo prazo exigido por lei para registros fiscais.</li>
<li>Painel remoto: o conteúdo temporário do console some quando o app desconecta; o cadastro do dispositivo fica até você removê-lo.</li>
<li>Ligação com o Discord e suas preferências: até você desvincular (no app ou com <code>/cubicase desvincular</code>) ou apagar o servidor; nomes de jogadores online: poucos minutos; identificador usado no intervalo entre comandos: cerca de 1 minuto.</li>
<li>Inscrição de notificações do painel: até você desativá-las ou remover o dispositivo.</li>
<li>Mensagens da Central de Ajuda: pelo tempo necessário para atender e documentar o pedido.</li>
</ul>`],
        ["7. Transferência internacional", `<p>Os prestadores acima operam servidores fora do Brasil. Ao usar o serviço, seus dados podem ser tratados em outros países, com salvaguardas contratuais dos próprios prestadores e conforme a LGPD (art. 33).</p>`],
        ["8. Segurança", `<p>Usamos conexões criptografadas (HTTPS e criptografia da rede), guardamos o segredo de dono de cada servidor apenas como hash, limitamos o acesso a credenciais e aplicamos limites de uso contra abuso. Nenhum sistema é totalmente seguro; se houver um incidente que possa afetar você, avisaremos como a lei exige.</p>`],
        ["9. Seus direitos", `<p>Você pode pedir: confirmação de que tratamos seus dados; acesso; correção; anonimização, bloqueio ou eliminação de dados desnecessários ou tratados em desacordo com a lei; portabilidade; informação sobre com quem compartilhamos; eliminação de dados tratados com consentimento; e a revogação do consentimento. Também pode peticionar à Autoridade Nacional de Proteção de Dados (ANPD). Use os contatos da seção 1; podemos pedir uma confirmação de identidade.</p>`],
        ["10. Crianças e adolescentes", `<p>O uso básico do app não exige dados pessoais. Contas, assinaturas e o painel remoto são destinados a maiores de 18 anos; menores devem usá-los com a participação e a autorização de um responsável legal. Não coletamos conscientemente dados pessoais de crianças além do necessário para o funcionamento; se você é responsável por uma criança e acredita que ela nos enviou dados, entre em contato para que possamos removê-los.</p>`],
        ["11. Alterações desta política", `<p>Podemos atualizar esta política. A data de atualização fica no topo; mudanças relevantes serão destacadas no app ou no site.</p>`],
      ],
    },
    en: {
      title: "Privacy Policy — Cubicase",
      desc: "Which data Cubicase handles, why, who it is shared with and how to exercise your rights.",
      h1: "Privacy Policy",
      lead: "Summary: Cubicase works without an account, has no ads and uses no behavioral analytics. Your server and worlds stay on your computer. Below is everything that goes through our infrastructure, and why.",
      sections: [
        ["1. Who is responsible", `<p><strong>Cubicase</strong> is an independent project, developed and operated in Brazil (“we”). We are the controller of the data described here under the Brazilian General Data Protection Law (LGPD, Law 13,709/2018) and, where applicable, comparable laws.</p>
<p>Privacy contact and exercise of rights: through the <strong>in-app Help Center</strong> (Help → Send message) or by e-mail at ${MAIL}.</p>`],
        ["2. What stays on your computer", `<p>Servers, worlds, backups, mods, app settings, the app's technical log (<code>cubeforge_debug.log</code>) and the owner secret of your servers stay in folders on your computer (Documents/CubicaseServers, the backups folder — by default Documents/CubicaseBackups, or the one you choose in Settings — and the app data folder). <strong>We do not upload these files.</strong> The technical log only leaves your computer if you copy and send it with a help request.</p>`],
        ["3. Data we handle and why", `<table>
<thead><tr><th>Situation</th><th>Data</th><th>Purpose</th></tr></thead>
<tbody>
<tr><td><strong>Using the app (no account)</strong></td><td>A random installation identifier (not your name or e-mail); app version; the IP address of your connection (seen by the infrastructure and used for up to ~1 minute to limit abuse).</td><td>Make the service work and protect it from abuse.</td></tr>
<tr><td><strong>Registering a server to invite friends</strong></td><td>Invite code, server name, Minecraft version, type/loader, description, state (online/offline), number of online players and whether the host is connected. If you use Radmin VPN as plan B, also your address on that network (26.x.x.x range) and the server port, while it is on. The owner secret is stored only as a <em>hash</em>.</td><td>Let your friends find and join the server.</td></tr>
<tr><td><strong>Joining as a guest</strong></td><td>The code you type; installation identifier; temporary connection credentials (valid for up to 24 hours).</td><td>Connect you to the host's server.</td></tr>
<tr><td><strong>Connection between host and guests</strong></td><td>To link the computers, the app exchanges network addresses (each side's public IP address and local addresses) through a temporary signaling room on our server. <strong>With the direct connection, host and guests get to see each other's IP address</strong>, which is inherent to this kind of connection; private mode (Cubicase Plus) hides the host's IP. When a direct connection is not possible, traffic goes through a backup server that relays already-encrypted data and records the volume relayed per server.</td><td>Connect host and guests and measure the backup server's monthly allowance.</td></tr>
<tr><td><strong>Account (optional)</strong></td><td>E-mail and, if you sign in with Google or Discord, the profile name and picture they provide.</td><td>Authenticate you and enable account features.</td></tr>
<tr><td><strong>Cubicase Plus</strong></td><td>Stripe customer and subscription identifiers, plan, status and renewal date. <strong>We do not receive or store card data</strong>; payment happens on Stripe's page.</td><td>Bill you and enable paid features.</td></tr>
<tr><td><strong>Remote web panel (Plus)</strong></td><td>Computer name, device token, last seen, invited accounts and permissions. While the app is connected: server state, server list, online players, computer usage metrics and the last ~200 console lines, plus commands sent from the panel. This temporary content is deleted when the app disconnects.</td><td>Control the server from a browser.</td></tr>
<tr><td><strong>Installed panel notifications (Plus)</strong></td><td>The address of your browser or phone's notification subscription, its public keys and your preferences (which alerts to get and the language). We send alerts such as “someone joined”, “server started” or “computer offline” to that address.</td><td>Alert you, on your phone or browser, about what happens on the server.</td></tr>
<tr><td><strong>Discord bot (optional)</strong></td><td>When you link a Discord to your server: the identifiers of the linked Discord and Cubicase server, the identifiers of the chosen channels and operator role, the language and alert preferences, and the messages the bot posts. <strong>Names of online players</strong> are sent by the app to our service only while a Discord is linked to the server, are used only to announce who joined and left, and disappear within minutes together with the server state. When someone uses a control command, their identifier is kept for about 1 minute (spacing between commands), and their display name appears in the channel alert and in the host's console. Discord sees what the bot posts and the commands typed there, under Discord's own policy.</td><td>Show status and alerts on Discord and let people control the server from there (control, several Discords and backup are part of Plus).</td></tr>
<tr><td><strong>Custom link and address (Plus)</strong></td><td>The chosen name, linked to your server and your account.</td><td>Show the link/address you configured.</td></tr>
<tr><td><strong>Help Center</strong></td><td>The e-mail, subject and message you write, plus the app version and operating system.</td><td>Answer your request.</td></tr>
<tr><td><strong>Donations</strong></td><td>Amount and currency confirmed by Stripe. We do not store your payment details.</td><td>Record the support received.</td></tr>
</tbody></table>`],
        ["4. Who we share it with (processors and third parties)", `<p>We do not sell data and we show no advertising. We use these providers to deliver the service; each handles data under its own policy:</p>
<ul>
<li><strong>Cloudflare</strong> — Cubicase API, storage of server records and the remote panel.</li>
<li><strong>Supabase</strong> — accounts, subscriptions and remote panel data.</li>
<li><strong>Stripe</strong> — payments (subscriptions and donations).</li>
<li><strong>Discord</strong> — the platform where the Cubicase bot posts messages and receives commands, only in the Discord servers where you added it. Discord handles that data under its own policy.</li>
<li><strong>Browser notification services (Google, Apple, Mozilla, Microsoft)</strong> — deliver the installed panel's notifications; they receive the (already encrypted) alert and the subscription address.</li>
<li><strong>Resend</strong> — delivery of Help Center e-mails to us.</li>
<li><strong>Oracle Cloud</strong> — backup (relay) server in São Paulo, used only when a direct connection is not possible; it sees the IP addresses of whoever uses it and the volume relayed, but not the content (the connection is encrypted).</li>
<li><strong>Radmin VPN (Famatech)</strong> — an independent program you may install as a connection plan B. Cubicase sends it no data: it only checks on this computer whether it is installed and connected and, if you ask, installs it through Microsoft's winget. Radmin's use follows its own policy; in this mode the game traffic goes through the Radmin network, not through us.</li>
<li><strong>Google (STUN servers)</strong> — used to discover the public IP address needed for the direct connection; Google sees the IP of whoever queries.</li>
<li><strong>GitHub</strong> — hosting of the website and of the app installers/updates (the app checks published versions).</li>
<li><strong>Mojang/Microsoft, Adoptium, PaperMC, Forge/NeoForge, Fabric</strong> — where the app downloads the server, Java and installers; they see the IP of whoever downloads.</li>
<li><strong>Modrinth and CurseForge</strong> — mod search and download; they receive the search terms and, to identify mods, file hash codes (never the files).</li>
<li><strong>Google Fonts</strong> — fonts for the website pages (Google sees the IP of whoever opens the pages).</li>
</ul>
<p>We may also disclose data when legally required or ordered by a competent authority.</p>`],
        ["5. Legal bases (LGPD, art. 7)", `<p><strong>Performance of a contract</strong> (providing the app and the features you asked for, including the subscription), <strong>legitimate interest</strong> (security, abuse and fraud prevention, and basic network operation) and <strong>compliance with a legal obligation</strong> (for example, tax records of the subscription). Where required we ask for your <strong>consent</strong>, which you can withdraw at any time.</p>`],
        ["6. How long we keep it", `<ul>
<li>Connection credentials and sessions: expire within 24 hours.</li>
<li>Monthly backup-server usage (bytes relayed per server): up to 40 days.</li>
<li>Per-IP anti-abuse counters: about 1 minute.</li>
<li>Server record: until you delete the server in the app or ask for removal.</li>
<li>Account: as long as it exists; you may ask for deletion.</li>
<li>Subscription data: while the subscription exists and for the period required by law for tax records.</li>
<li>Remote panel: temporary console content disappears when the app disconnects; the device registration stays until you remove it.</li>
<li>Discord link and its preferences: until you unlink (in the app or with <code>/cubicase unlink</code>) or delete the server; names of online players: a few minutes; identifier used for the spacing between commands: about 1 minute.</li>
<li>Panel notification subscription: until you turn it off or remove the device.</li>
<li>Help Center messages: as long as needed to handle and document the request.</li>
</ul>`],
        ["7. International transfers", `<p>The providers above operate servers outside Brazil. By using the service your data may be processed in other countries, under the providers' own contractual safeguards and in line with the LGPD (art. 33).</p>`],
        ["8. Security", `<p>We use encrypted connections (HTTPS and network encryption), store each server's owner secret only as a hash, restrict access to credentials and apply usage limits against abuse. No system is fully secure; if an incident may affect you, we will notify you as the law requires.</p>`],
        ["9. Your rights", `<p>You may ask for: confirmation that we process your data; access; correction; anonymization, blocking or deletion of unnecessary data or data processed unlawfully; portability; information about who we share data with; deletion of data processed on the basis of consent; and withdrawal of consent. You may also complain to Brazil's data protection authority (ANPD). Use the contacts in section 1; we may ask you to confirm your identity.</p>`],
        ["10. Children and teenagers", `<p>Basic use of the app requires no personal data. Accounts, subscriptions and the remote panel are intended for people aged 18 or over; minors must use them with the participation and authorization of a legal guardian. We do not knowingly collect personal data from children beyond what is needed to operate; if you are responsible for a child and believe they sent us data, contact us so we can remove it.</p>`],
        ["11. Changes to this policy", `<p>We may update this policy. The update date is at the top; relevant changes will be highlighted in the app or on the website.</p>`],
      ],
    },
  },

  terms: {
    paths: { pt: "/termos/", en: "/en/terms/" },
    pt: {
      title: "Termos de Uso — Cubicase",
      desc: "As regras de uso do Cubicase, do Cubicase Plus e do serviço de conexão entre host e convidados.",
      h1: "Termos de Uso",
      lead: "Ao instalar ou usar o Cubicase você concorda com estes termos. Se não concordar, não use o app.",
      sections: [
        ["1. O que é o Cubicase", `<p>O Cubicase é um aplicativo para Windows que ajuda você a criar e hospedar servidores de Minecraft Java <strong>no seu próprio computador</strong> e a convidar amigos sem abrir portas no roteador. Nós <strong>não hospedamos</strong> o seu servidor nem os seus mundos: fornecemos o programa e um serviço de conexão (registro de códigos de convite e rede entre host e convidados).</p>
<p>O Cubicase é um projeto independente. <strong>Não é afiliado, associado nem endossado pela Mojang Studios nem pela Microsoft.</strong> Minecraft é uma marca registrada da Mojang Synergies AB.</p>`],
        ["2. EULA do Minecraft e regras de terceiros", `<p>Para criar um servidor você precisa aceitar o <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noopener">EULA do Minecraft</a>. O Cubicase só grava <code>eula=true</code> depois que <em>você</em> marca a caixa de aceite. Você é responsável por cumprir o EULA e as <a href="https://www.minecraft.net/usage-guidelines" target="_blank" rel="noopener">diretrizes de uso</a> da Mojang, inclusive as regras sobre monetização de servidores. Mods, modpacks, Java e demais componentes têm licenças e termos próprios.</p>`],
        ["3. Conta e idade", `<p>Você pode usar o app sem conta. Contas, assinaturas e o painel remoto são destinados a maiores de 18 anos; menores devem ter a participação e a autorização de um responsável legal. Mantenha seus dados de acesso em segurança; você é responsável pelas ações feitas na sua conta.</p>`],
        ["4. Uso aceitável", `<p>É proibido usar o Cubicase para: violar a lei ou direitos de terceiros; hospedar ou distribuir conteúdo ilícito ou malicioso (inclusive mods e pacotes com malware); assediar, ameaçar ou enganar pessoas; atacar redes ou computadores; sobrecarregar, automatizar em massa, contornar limites ou tentar obter acesso não autorizado ao serviço ou a servidores de outras pessoas; e se passar por outra pessoa. Podemos limitar ou suspender o acesso a quem violar estas regras.</p>`],
        ["5. Responsabilidades do host", `<p>Quem hospeda é responsável pelo seu servidor: conteúdo, regras, moderação e jogadores convidados. <strong>Mods e pacotes são programas que rodam no seu computador</strong>: instale e importe apenas de fontes em que você confia. Faça cópias de segurança dos seus mundos; o backup automático do app ajuda, mas não é garantia. O código de convite dá acesso ao servidor a quem o tiver: compartilhe com cuidado e use a whitelist e a opção de regenerar o código.</p>
<p><strong>Bot do Discord:</strong> quem liga um Discord ao servidor e define o cargo de operador é responsável por quem passa a poder ver o status e, com o Plus, ligar, desligar, reiniciar, fazer backup e (se liberado) enviar comandos ao console. O bot também precisa respeitar os Termos e as Diretrizes do Discord. Podemos pausar ou remover a ligação se houver abuso.</p>`],
        ["6. Cubicase Plus", `<ul>
<li>É uma assinatura mensal ou anual, com os valores exibidos no momento da contratação. Os recursos incluídos são os descritos na página do plano e podem evoluir.</li>
<li>O pagamento é processado pela Stripe. A assinatura <strong>renova automaticamente</strong> até ser cancelada.</li>
<li>Você cancela quando quiser pelo portal de assinatura (Configurações do app → Conta); o acesso continua até o fim do período já pago.</li>
<li><strong>Direito de arrependimento:</strong> em contratações feitas pela internet você pode desistir em até 7 dias corridos da contratação, com reembolso, conforme o art. 49 do Código de Defesa do Consumidor. Peça pelos contatos da <a href="/privacidade/">Política de Privacidade</a>.</li>
<li>O Plus inclui, entre outros, o painel web e as notificações, o servidor que liga sozinho, link e endereço personalizados, o modo privado e, no Discord, o controle do servidor, vários Discords e vários servidores por Discord. Sem o Plus, o Discord continua com o status e os avisos de um servidor em um Discord.</li>
<li>Se a assinatura deixar de estar ativa, os recursos pagos deixam de funcionar; o uso básico do app continua gratuito. Ligações do Discord além do que o plano grátis permite continuam por 7 dias e depois são <strong>pausadas, sem serem apagadas</strong>; voltam quando o Plus volta.</li>
</ul>`],
        ["7. Doações", `<p>Doações são voluntárias e não geram contrapartida, benefício nem recursos adicionais.</p>`],
        ["8. Disponibilidade e mudanças", `<p>O serviço é oferecido <strong>“como está”</strong>, sem garantia de disponibilidade contínua. Podemos alterar, limitar ou descontinuar recursos (inclusive trocar provedores de infraestrutura e de rede), com aviso razoável quando possível. O app pode se atualizar automaticamente.</p>`],
        ["9. Limitação de responsabilidade", `<p>Na máxima extensão permitida em lei, não nos responsabilizamos por perda ou corrupção de mundos e dados, interrupções do serviço, falhas de terceiros (rede, provedores, Mojang/Microsoft, mods), ações de jogadores ou conteúdo hospedado por outros usuários. Nada nestes termos limita direitos que a lei do consumidor não permita limitar.</p>`],
        ["10. Suspensão e encerramento", `<p>Você pode parar de usar o Cubicase e apagar o app e os seus dados a qualquer momento. Podemos suspender ou encerrar o acesso a recursos do serviço em caso de violação destes termos, abuso ou exigência legal.</p>`],
        ["11. Propriedade intelectual e licenças", `<p>O nome e o logotipo do Cubicase pertencem ao desenvolvedor. O app inclui componentes de terceiros que mantêm suas próprias licenças; veja a página de <a href="/licencas/">Licenças</a>.</p>`],
        ["12. Alterações destes termos", `<p>Podemos atualizar estes termos; a data fica no topo. O uso continuado depois da mudança significa que você aceitou a nova versão. Se discordar, pare de usar o serviço.</p>`],
        ["13. Lei aplicável e foro", `<p>Estes termos seguem as leis do Brasil. Fica eleito o foro do domicílio do consumidor, quando aplicável, ou, nos demais casos, o foro da comarca do desenvolvedor.</p>`],
        ["14. Contato", `<p>Pela Central de Ajuda do app ou pelo e-mail ${MAIL}.</p>`],
      ],
    },
    en: {
      title: "Terms of Use — Cubicase",
      desc: "The rules for using Cubicase, Cubicase Plus and the connection service between host and guests.",
      h1: "Terms of Use",
      lead: "By installing or using Cubicase you agree to these terms. If you do not agree, do not use the app.",
      sections: [
        ["1. What Cubicase is", `<p>Cubicase is a Windows application that helps you create and host Minecraft Java servers <strong>on your own computer</strong> and invite friends without opening router ports. We <strong>do not host</strong> your server or your worlds: we provide the program and a connection service (invite code registry and network between host and guests).</p>
<p>Cubicase is an independent project. <strong>It is not affiliated with, associated with or endorsed by Mojang Studios or Microsoft.</strong> Minecraft is a registered trademark of Mojang Synergies AB.</p>`],
        ["2. Minecraft EULA and third-party rules", `<p>To create a server you must accept the <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noopener">Minecraft EULA</a>. Cubicase only writes <code>eula=true</code> after <em>you</em> tick the acceptance box. You are responsible for complying with the EULA and Mojang's <a href="https://www.minecraft.net/usage-guidelines" target="_blank" rel="noopener">usage guidelines</a>, including the rules on server monetization. Mods, modpacks, Java and other components have their own licenses and terms.</p>`],
        ["3. Account and age", `<p>You can use the app without an account. Accounts, subscriptions and the remote panel are intended for people aged 18 or over; minors need the participation and authorization of a legal guardian. Keep your sign-in details safe; you are responsible for actions taken in your account.</p>`],
        ["4. Acceptable use", `<p>You must not use Cubicase to: break the law or third-party rights; host or distribute unlawful or malicious content (including mods and packs with malware); harass, threaten or deceive people; attack networks or computers; overload the service, automate it at scale, bypass limits or try to gain unauthorized access to the service or to other people's servers; or impersonate someone else. We may limit or suspend access for anyone who breaks these rules.</p>`],
        ["5. Host responsibilities", `<p>Whoever hosts is responsible for their server: content, rules, moderation and invited players. <strong>Mods and packs are programs that run on your computer</strong>: install and import only from sources you trust. Back up your worlds; the app's automatic backup helps but is not a guarantee. The invite code gives access to the server to anyone who has it: share it carefully and use the whitelist and the regenerate-code option.</p>
<p><strong>Discord bot:</strong> whoever links a Discord to the server and sets the operator role is responsible for who can see the status and, with Plus, start, stop, restart, back up and (if enabled) send commands to the console. The bot must also respect Discord's Terms and Guidelines. We may pause or remove the link in case of abuse.</p>`],
        ["6. Cubicase Plus", `<ul>
<li>It is a monthly or yearly subscription, at the prices shown when you subscribe. Included features are those described on the plan page and may evolve.</li>
<li>Payment is processed by Stripe. The subscription <strong>renews automatically</strong> until cancelled.</li>
<li>You can cancel at any time in the billing portal (app Settings → Account); access continues until the end of the period already paid.</li>
<li><strong>Right of withdrawal:</strong> for purchases made online you may withdraw within 7 calendar days of purchase and get a refund, under art. 49 of Brazil's Consumer Defense Code. Ask through the contacts in the <a href="/en/privacy/">Privacy Policy</a>.</li>
<li>Plus includes, among others, the web panel and notifications, the server that starts by itself, custom link and address, private mode and, on Discord, server control, several Discords and several servers per Discord. Without Plus, Discord keeps the status and alerts of one server in one Discord.</li>
<li>If the subscription stops being active, paid features stop working; basic use of the app stays free. Discord links beyond what the free plan allows keep working for 7 days and are then <strong>paused, not deleted</strong>; they come back when Plus returns.</li>
</ul>`],
        ["7. Donations", `<p>Donations are voluntary and give no consideration, benefit or additional features.</p>`],
        ["8. Availability and changes", `<p>The service is provided <strong>“as is”</strong>, with no guarantee of continuous availability. We may change, limit or discontinue features (including switching infrastructure and network providers), with reasonable notice when possible. The app may update itself automatically.</p>`],
        ["9. Limitation of liability", `<p>To the fullest extent allowed by law, we are not liable for loss or corruption of worlds and data, service interruptions, failures of third parties (network, providers, Mojang/Microsoft, mods), the actions of players or content hosted by other users. Nothing in these terms limits rights that consumer law does not allow to be limited.</p>`],
        ["10. Suspension and termination", `<p>You may stop using Cubicase and delete the app and your data at any time. We may suspend or end access to parts of the service for violations of these terms, abuse or legal requirement.</p>`],
        ["11. Intellectual property and licenses", `<p>The Cubicase name and logo belong to the developer. The app includes third-party components that keep their own licenses; see the <a href="/en/licenses/">Licenses</a> page.</p>`],
        ["12. Changes to these terms", `<p>We may update these terms; the date is at the top. Continued use after a change means you accepted the new version. If you disagree, stop using the service.</p>`],
        ["13. Governing law and venue", `<p>These terms are governed by the laws of Brazil. The venue is the consumer's place of residence, where applicable, or otherwise the developer's judicial district.</p>`],
        ["14. Contact", `<p>Through the app's Help Center or by e-mail at ${MAIL}.</p>`],
      ],
    },
  },

  licenses: {
    paths: { pt: "/licencas/", en: "/en/licenses/" },
    pt: {
      title: "Licenças de terceiros — Cubicase",
      desc: "Componentes de código aberto usados pelo Cubicase e suas licenças.",
      h1: "Licenças de terceiros",
      lead: "O Cubicase é construído sobre software livre e de código aberto. Agradecemos às pessoas que o mantêm. Abaixo estão os principais componentes e suas licenças; os textos completos e os avisos de copyright acompanham cada pacote.",
      sections: [
        ["Aplicativo (interface e sistema)", `<table><thead><tr><th>Componente</th><th>Licença</th></tr></thead><tbody>
<tr><td>Tauri (e plugins oficiais)</td><td>MIT ou Apache-2.0</td></tr>
<tr><td>Next.js, React, React DOM, next-themes</td><td>MIT</td></tr>
<tr><td>Zustand, clsx, tailwind-merge, Tailwind CSS</td><td>MIT</td></tr>
<tr><td>Framer Motion</td><td>MIT</td></tr>
<tr><td>lucide-react</td><td>ISC</td></tr>
<tr><td>Supabase JS</td><td>MIT</td></tr>
<tr><td>Bibliotecas Rust: serde, tokio, reqwest, chrono, uuid, rand, zip, image, walkdir, sha2, base64, sysinfo, tiny_http, tokio-tungstenite, portable-pty, hematite-nbt, md5, sha1_smol, windows-sys e dependências</td><td>MIT, Apache-2.0, BSD ou Unlicense (conforme cada pacote)</td></tr>
</tbody></table>`],
        ["Rede (sidecar)", `<p><strong>Pion WebRTC</strong> e módulos Pion (ice, dtls, sctp, turn, stun, srtp, rtp, rtcp, sdp, mdns, transport, logging, randutil, datachannel, interceptor) — © The Pion community e autores de cada módulo — licença MIT. O texto abaixo é o do módulo principal; os demais módulos do Pion usam a mesma licença, com seus próprios avisos de copyright:</p>
<pre>MIT License

Copyright (c) 2026 The Pion community &lt;https://pion.ly&gt;

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.</pre>
<p><strong>coder/websocket</strong> — © Coder — licença ISC:</p>
<pre>Copyright (c) 2025 Coder

Permission to use, copy, modify, and distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.</pre>
<p><strong>golang.org/x/crypto</strong> (e demais módulos <code>golang.org/x/*</code>) — © The Go Authors — licença BSD de 3 cláusulas:</p>
<pre>Copyright 2009 The Go Authors.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google LLC nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.</pre>`],
        ["Fontes do site", `<p>Inter e Space Grotesk — SIL Open Font License 1.1 (fornecidas pelo Google Fonts).</p>`],
        ["Marcas", `<p>Minecraft é uma marca registrada da Mojang Synergies AB. Stripe, Supabase, Cloudflare, GitHub, Modrinth e CurseForge são marcas de seus respectivos donos. O Cubicase não é afiliado a nenhum deles.</p>`],
      ],
    },
    en: {
      title: "Third-party licenses — Cubicase",
      desc: "Open-source components used by Cubicase and their licenses.",
      h1: "Third-party licenses",
      lead: "Cubicase is built on free and open-source software. We thank the people who maintain it. Below are the main components and their licenses; full texts and copyright notices ship with each package.",
      sections: [
        ["Application (interface and system)", `<table><thead><tr><th>Component</th><th>License</th></tr></thead><tbody>
<tr><td>Tauri (and official plugins)</td><td>MIT or Apache-2.0</td></tr>
<tr><td>Next.js, React, React DOM, next-themes</td><td>MIT</td></tr>
<tr><td>Zustand, clsx, tailwind-merge, Tailwind CSS</td><td>MIT</td></tr>
<tr><td>Framer Motion</td><td>MIT</td></tr>
<tr><td>lucide-react</td><td>ISC</td></tr>
<tr><td>Supabase JS</td><td>MIT</td></tr>
<tr><td>Rust libraries: serde, tokio, reqwest, chrono, uuid, rand, zip, image, walkdir, sha2, base64, sysinfo, tiny_http, tokio-tungstenite, portable-pty, hematite-nbt, md5, sha1_smol, windows-sys and dependencies</td><td>MIT, Apache-2.0, BSD or Unlicense (per package)</td></tr>
</tbody></table>`],
        ["Networking (sidecar)", `<p><strong>Pion WebRTC</strong> and Pion modules (ice, dtls, sctp, turn, stun, srtp, rtp, rtcp, sdp, mdns, transport, logging, randutil, datachannel, interceptor) — © The Pion community and each module's authors — MIT license. The text below is the main module's; the other Pion modules use the same license with their own copyright notices:</p>
<pre>MIT License

Copyright (c) 2026 The Pion community &lt;https://pion.ly&gt;

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.</pre>
<p><strong>coder/websocket</strong> — © Coder — ISC license:</p>
<pre>Copyright (c) 2025 Coder

Permission to use, copy, modify, and distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.</pre>
<p><strong>golang.org/x/crypto</strong> (and the other <code>golang.org/x/*</code> modules) — © The Go Authors — BSD 3-Clause license:</p>
<pre>Copyright 2009 The Go Authors.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google LLC nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.</pre>`],
        ["Website fonts", `<p>Inter and Space Grotesk — SIL Open Font License 1.1 (served by Google Fonts).</p>`],
        ["Trademarks", `<p>Minecraft is a registered trademark of Mojang Synergies AB. Stripe, Supabase, Cloudflare, GitHub, Modrinth and CurseForge are trademarks of their respective owners. Cubicase is not affiliated with any of them.</p>`],
      ],
    },
  },

  discord: {
    paths: { pt: "/discord/", en: "/en/discord/" },
    pt: {
      title: "Cubicase no Discord — status, avisos e controle do servidor",
      desc: "Como ligar o bot do Cubicase ao seu Discord: status ao vivo, avisos de quem entra, passo a passo para os amigos e, com o Plus, ligar, desligar e fazer backup pelo Discord.",
      h1: "Cubicase no Discord",
      lead: "O bot do Cubicase mostra no seu Discord se o servidor está ligado e quem está jogando, avisa quando alguém entra, fixa o passo a passo para os amigos entrarem e, com o Cubicase Plus, deixa quem você escolher ligar, desligar e fazer backup do servidor sem abrir o computador.",
      sections: [
        ["1. O que o bot faz", `<ul>
<li><strong>Status ao vivo:</strong> uma mensagem que se atualiza sozinha com ligado/desligado, jogadores online, versão e o botão de entrar.</li>
<li><strong>Avisos:</strong> “servidor ligado”, “desligado”, “caiu” e quem entrou e saiu (agrupados, sem inundar o canal). Você liga ou desliga cada tipo.</li>
<li><strong>Como entrar:</strong> uma mensagem fixada com o passo a passo e o link do servidor, para os amigos não precisarem perguntar.</li>
<li><strong>Controle pelo Discord (Cubicase Plus):</strong> ligar, desligar, reiniciar, fazer backup, mexer na whitelist e, se você liberar, enviar comandos ao console.</li>
</ul>`],
        ["2. Como ligar o bot ao seu Discord", `<ol>
<li>No Cubicase, abra o servidor, vá em <strong>Configurações</strong> e procure o cartão <strong>Discord</strong>. Clique em <strong>Adicionar o bot</strong> e autorize no Discord (você precisa da permissão <em>Gerenciar Servidor</em> no Discord).</li>
<li>Ainda no cartão, clique em <strong>Gerar código</strong>. Ele vale por 10 minutos e só pode ser usado uma vez.</li>
<li>No Discord, quem tem <em>Gerenciar Servidor</em> digita <code>/cubicase vincular</code> e cola o código.</li>
<li>Escolha onde ficam o status, os avisos e o “como entrar”: pelo cartão no app (menus de canal) ou no Discord com <code>/cubicase canal</code>. Use <strong>Enviar mensagem de teste</strong> para conferir.</li>
</ol>
<p>Pronto: o app do host precisa estar aberto para o status e os avisos acompanharem o servidor.</p>`],
        ["3. Comandos", `<table>
<thead><tr><th>Comando</th><th>Quem pode</th><th>O que faz</th></tr></thead>
<tbody>
<tr><td><code>/cubicase status</code></td><td>Todos</td><td>Mostra se está ligado, jogadores e como entrar.</td></tr>
<tr><td><code>/cubicase ajuda</code></td><td>Todos</td><td>Explica o bot e os comandos.</td></tr>
<tr><td><code>/cubicase vincular</code>, <code>desvincular</code></td><td>Gerenciar Servidor</td><td>Liga ou remove a ligação com o servidor do Cubicase.</td></tr>
<tr><td><code>/cubicase canal</code>, <code>avisos</code>, <code>convite</code>, <code>desativar</code></td><td>Gerenciar Servidor</td><td>Escolhe canais, liga e desliga avisos, publica o “como entrar”.</td></tr>
<tr><td><code>/cubicase diagnostico</code></td><td>Gerenciar Servidor</td><td>Confere se o bot está no servidor e enxerga o canal.</td></tr>
<tr><td><code>/cubicase operador</code></td><td>Gerenciar Servidor</td><td>Define o cargo que também pode controlar e libera o console.</td></tr>
<tr><td><code>/cubicase ligar</code>, <code>desligar</code>, <code>reiniciar</code>, <code>backup</code>, <code>whitelist</code></td><td>Gerenciar Servidor ou cargo de operador (Plus)</td><td>Controla o servidor. Cada uso deixa um registro no canal de avisos.</td></tr>
<tr><td><code>/cubicase console</code></td><td>Como acima, e só se liberado (Plus)</td><td>Envia um comando ao console do servidor.</td></tr>
</tbody></table>`],
        ["4. Grátis e Cubicase Plus", `<ul>
<li><strong>Grátis:</strong> status ao vivo, avisos e “como entrar”, para um servidor em um Discord.</li>
<li><strong>Cubicase Plus:</strong> controle do servidor pelo Discord (ligar, desligar, reiniciar, backup, whitelist e console), vários Discords por servidor e vários servidores por Discord.</li>
<li>Se o Plus terminar, o que passar do plano grátis continua por 7 dias e depois fica <strong>pausado, sem ser apagado</strong>. Quando o Plus volta, tudo volta.</li>
</ul>`],
        ["5. Permissões do bot", `<p>O bot pede só o necessário para publicar e fixar mensagens: ver canais, enviar mensagens, incorporar links, ler o histórico e fixar mensagens. <strong>Ele não pede Administrador e não lê as conversas do seu Discord</strong>: só reage aos comandos <code>/cubicase</code> e escreve nos canais que você escolher.</p>`],
        ["6. Privacidade e como remover", `<ul>
<li>Guardamos os identificadores do seu Discord e dos canais escolhidos, e as suas preferências. Os nomes dos jogadores online só são enviados enquanto há um Discord ligado e servem para avisar quem entrou e saiu. Detalhes na <a href="/privacidade/">Política de Privacidade</a>.</li>
<li>Para remover: <code>/cubicase desvincular</code>, o botão <strong>Desvincular</strong> no cartão do app, ou expulse o bot do seu Discord.</li>
</ul>`],
        ["7. Problemas comuns", `<ul>
<li><strong>“Não consegui escrever no canal”:</strong> rode <code>/cubicase diagnostico</code> no canal. Ele diz se o token, o servidor e o canal estão certos; o mais comum é uma regra de permissão do canal ou da categoria bloqueando o bot.</li>
<li><strong>“O Cubicase do host está fechado”:</strong> o app precisa estar aberto no computador do host para ligar, desligar e fazer backup.</li>
<li><strong>“Faz parte do Cubicase Plus”:</strong> o Plus é conferido na conta que ligou o servidor. Se você trocou de conta, abra o cartão Discord logado na conta com Plus e clique em <strong>Gerar código</strong>.</li>
<li><strong>Backup grande:</strong> a mensagem do comando é atualizada quando o backup termina (pode levar alguns minutos).</li>
</ul>`],
        ["8. Contato", `<p>Pela Central de Ajuda do app ou pelo e-mail ${MAIL}. O bot é independente e não é afiliado ao Discord Inc.</p>`],
      ],
    },
    en: {
      title: "Cubicase on Discord — server status, alerts and control",
      desc: "How to link the Cubicase bot to your Discord: live status, who-joined alerts, a step-by-step for friends and, with Plus, start, stop and back up from Discord.",
      h1: "Cubicase on Discord",
      lead: "The Cubicase bot shows on your Discord whether the server is on and who is playing, announces when someone joins, pins the step-by-step for friends to get in and, with Cubicase Plus, lets the people you choose start, stop and back up the server without opening the computer.",
      sections: [
        ["1. What the bot does", `<ul>
<li><strong>Live status:</strong> a message that updates itself with on/off, online players, version and a join button.</li>
<li><strong>Alerts:</strong> “server online”, “stopped”, “went down” and who joined and left (grouped, so the channel isn't flooded). You turn each type on or off.</li>
<li><strong>How to join:</strong> a pinned message with the step-by-step and the server link, so friends don't have to ask.</li>
<li><strong>Control from Discord (Cubicase Plus):</strong> start, stop, restart, back up, manage the whitelist and, if you enable it, send commands to the console.</li>
</ul>`],
        ["2. How to link the bot to your Discord", `<ol>
<li>In Cubicase, open the server, go to <strong>Settings</strong> and find the <strong>Discord</strong> card. Click <strong>Add the bot</strong> and authorize it on Discord (you need the <em>Manage Server</em> permission there).</li>
<li>Still on the card, click <strong>Generate code</strong>. It is valid for 10 minutes and works once.</li>
<li>On Discord, someone with <em>Manage Server</em> types <code>/cubicase link</code> and pastes the code.</li>
<li>Pick where the status, alerts and “how to join” go: on the card in the app (channel menus) or on Discord with <code>/cubicase channel</code>. Use <strong>Send test message</strong> to check.</li>
</ol>
<p>That's it: the host's app must be open for the status and alerts to follow the server.</p>`],
        ["3. Commands", `<table>
<thead><tr><th>Command</th><th>Who can</th><th>What it does</th></tr></thead>
<tbody>
<tr><td><code>/cubicase status</code></td><td>Everyone</td><td>Shows whether it is on, players and how to join.</td></tr>
<tr><td><code>/cubicase help</code></td><td>Everyone</td><td>Explains the bot and the commands.</td></tr>
<tr><td><code>/cubicase link</code>, <code>unlink</code></td><td>Manage Server</td><td>Links or removes the link with the Cubicase server.</td></tr>
<tr><td><code>/cubicase channel</code>, <code>alerts</code>, <code>invite</code>, <code>disable</code></td><td>Manage Server</td><td>Picks channels, turns alerts on and off, posts the “how to join”.</td></tr>
<tr><td><code>/cubicase diagnostics</code></td><td>Manage Server</td><td>Checks that the bot is in the server and can see the channel.</td></tr>
<tr><td><code>/cubicase operator</code></td><td>Manage Server</td><td>Sets the role that can also control the server and enables the console.</td></tr>
<tr><td><code>/cubicase start</code>, <code>stop</code>, <code>restart</code>, <code>backup</code>, <code>whitelist</code></td><td>Manage Server or operator role (Plus)</td><td>Controls the server. Each use leaves a record in the alerts channel.</td></tr>
<tr><td><code>/cubicase console</code></td><td>As above, and only if enabled (Plus)</td><td>Sends a command to the server console.</td></tr>
</tbody></table>`],
        ["4. Free and Cubicase Plus", `<ul>
<li><strong>Free:</strong> live status, alerts and “how to join”, for one server in one Discord.</li>
<li><strong>Cubicase Plus:</strong> control of the server from Discord (start, stop, restart, backup, whitelist and console), several Discords per server and several servers per Discord.</li>
<li>If Plus ends, anything beyond the free plan keeps working for 7 days and is then <strong>paused, not deleted</strong>. When Plus returns, everything comes back.</li>
</ul>`],
        ["5. Bot permissions", `<p>The bot asks only for what it needs to post and pin messages: view channels, send messages, embed links, read history and pin messages. <strong>It does not ask for Administrator and does not read your Discord's conversations</strong>: it only reacts to <code>/cubicase</code> commands and writes in the channels you choose.</p>`],
        ["6. Privacy and how to remove it", `<ul>
<li>We store the identifiers of your Discord and the chosen channels, and your preferences. Names of online players are only sent while a Discord is linked and are used to announce who joined and left. Details in the <a href="/en/privacy/">Privacy Policy</a>.</li>
<li>To remove: <code>/cubicase unlink</code>, the <strong>Unlink</strong> button on the app's card, or kick the bot from your Discord.</li>
</ul>`],
        ["7. Common problems", `<ul>
<li><strong>“I couldn't write in the channel”:</strong> run <code>/cubicase diagnostics</code> in the channel. It tells you whether the token, server and channel are right; the most common cause is a channel or category permission rule blocking the bot.</li>
<li><strong>“The host's Cubicase is closed”:</strong> the app must be open on the host's computer to start, stop and back up.</li>
<li><strong>“Part of Cubicase Plus”:</strong> Plus is checked on the account that linked the server. If you switched accounts, open the Discord card signed in with the Plus account and click <strong>Generate code</strong>.</li>
<li><strong>Big backups:</strong> the command's message is updated when the backup finishes (it can take a few minutes).</li>
</ul>`],
        ["8. Contact", `<p>Through the app's Help Center or by e-mail at ${MAIL}. The bot is independent and not affiliated with Discord Inc.</p>`],
      ],
    },
  },
};

// ============================================================
// Template
// ============================================================
const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function render(pageKey, lang) {
  const page = PAGES[pageKey];
  const c = page[lang];
  const nav = NAV[lang];
  const f = FOOTER[lang];
  const other = lang === "pt" ? "en" : "pt";
  const htmlLang = lang === "pt" ? "pt-BR" : "en";
  const sections = c.sections.map(([h, body]) => `      <section class="legal-section">\n        <h2>${h}</h2>\n        ${body.replace(/\n/g, "\n        ")}\n      </section>`).join("\n");
  const updatedLabel = lang === "pt" ? "Atualizado em" : "Last updated";
  return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(c.title)}</title>
  <meta name="description" content="${esc(c.desc)}" />
  <link rel="icon" type="image/png" href="/assets/icon.png" />
  <link rel="apple-touch-icon" href="/assets/icon.png" />
  <meta property="og:title" content="${esc(c.title)}" />
  <meta property="og:description" content="${esc(c.desc)}" />
  <meta property="og:image" content="/assets/logo.png" />
  <meta property="og:type" content="website" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/assets/style.css" />
  <link rel="alternate" hreflang="pt-BR" href="${page.paths.pt}" />
  <link rel="alternate" hreflang="en" href="${page.paths.en}" />
  <link rel="alternate" hreflang="x-default" href="${page.paths.pt}" />
  <script src="/assets/i18n/en.js"></script>
  <script src="/assets/i18n.js"></script>
</head>
<body>
  <div class="ambient-glow"></div>

  <nav class="nav">
    <div class="container nav-inner">
      <a href="${nav.home}" class="nav-brand">
        <img src="/assets/logo-dark.png" alt="Cubicase" />
      </a>
      <div class="nav-links" data-nav-links>
        <a href="${nav.home}#recursos">${nav.features}</a>
        <a href="${nav.home}#como-funciona">${nav.how}</a>
        <a href="${nav.tutorialHref}">${nav.tutorial}</a>
        <a href="https://github.com/FelipoArts/cubicase" target="_blank" rel="noopener">GitHub</a>
        <div class="lang-switch" data-lang-switch></div>
        <a class="btn btn-ghost nav-auth" href="/painel/" data-auth-link>${nav.signin}</a>
        <div class="nav-cta">
          <a class="btn btn-primary" href="${nav.downloadHref}">${nav.download}</a>
        </div>
      </div>
      <button class="nav-toggle" data-nav-toggle aria-label="${nav.menu}" aria-expanded="false">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </button>
    </div>
  </nav>

  <header class="download-hero legal-hero">
    <div class="container">
      <h1>${c.h1}</h1>
      <p class="legal-updated">${updatedLabel}: ${UPDATED[lang]}</p>
    </div>
  </header>

  <main class="container legal">
    <p class="legal-lead">${c.lead}</p>
${sections}
  </main>

  <footer>
    <div class="container footer-inner">
      <div class="footer-brand">
        <img src="/assets/icon-dark.png" alt="" width="18" height="18" />
        © 2026 Cubicase
      </div>
      <div class="footer-links">
        <a href="${nav.home}">${nav.footerHome}</a>
        <a href="${nav.tutorialHref}">${nav.tutorial}</a>
        <a href="${f.discord[1]}">${f.discord[0]}</a>
        <a href="${f.privacy[1]}">${f.privacy[0]}</a>
        <a href="${f.terms[1]}">${f.terms[0]}</a>
        <a href="${f.licenses[1]}">${f.licenses[0]}</a>
        <a href="https://github.com/FelipoArts/cubicase" target="_blank" rel="noopener">GitHub</a>
      </div>
    </div>
    <div class="container footer-disclaimer">${f.disclaimer}</div>
  </footer>

  <script src="/assets/site.js"></script>
</body>
</html>
`;
}

const written = [];
for (const key of Object.keys(PAGES)) {
  for (const lang of ["pt", "en"]) {
    const rel = PAGES[key].paths[lang].replace(/^\//, "") + "index.html";
    const target = path.join(DOCS, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, render(key, lang));
    written.push(path.join("docs", rel));
  }
}
console.log("Geradas:\n" + written.map((w) => "  " + w).join("\n"));
