# Auditoria pré-divulgação — 2026-10-05

Revisão do código de ponta a ponta com foco em segurança, robustez e escala.
Complementa `pre-launch-findings.md` (28/09): conferi aquele arquivo contra o
código atual e a maior parte dos itens P0/P1 de lá **já foi corrigida**
(`atomic_write`, `is_safe_relative_component`, `ensure_mc_server_stopped`,
trava da fila de sync, rollback do restore). O que está abaixo é o que **sobrou
ou é novo**.

**Cobertura:** li com atenção `lib.rs` (comandos, shutdown, servidor HTTP local,
sync), `provider_manager.rs`, `session_manager.rs`, `panel_agent.rs`, trechos de
`pack.rs`/`hosting.rs`, o sidecar Go inteiro, a API Worker inteira
(`index.ts`, `host-channel.ts`, `panel-members.ts`, `panel-access.ts`,
`supabase.ts`), os SQLs do Supabase, `server.ts`, `modSync.ts`, `auth.ts`,
`joinDeepLink.ts`, configs do Tauri, CI e site do painel.
**Não li a fundo:** `page.tsx`, `HostView.tsx`, `GuestView.tsx`,
`ModBrowserModal.tsx`, `ServerConfigModal.tsx`, `mod_identity.rs`, o import de
`pack.rs`, `docs/` (fora o painel). **Não rodei:** `cargo test`, fluxos reais com
Tailscale/Minecraft. **Não consigo ver daqui:** a ACL do Tailscale e as policies
reais do Supabase (só os `.sql` do repo).
Verificado rodando: `tsc --noEmit` limpo; testes frontend 155/155 e API 93/93
passam.

Legenda: 🔴 bloqueia divulgação · 🟠 corrigir logo · 🟡 registrar

---

## 🔴 Bloqueadores

### 1. O shortCode (público por design) autoriza ações destrutivas e de dono — `api/src/index.ts`
O código do servidor é compartilhado com todo convidado (e `play.cubicase.net/<código em minúsculas>`
funciona de graça), mas é a **única** credencial das rotas de administração:
- `DELETE /api/v1/servers/{sc}` (L477, roteado em L1460) — apaga o servidor e **derruba a sessão/dispositivo Tailscale do host** (L462).
- `POST .../regenerate-code` (L506) — invalida o código e derruba todo mundo (limite de 5/min por IP não protege nada).
- `PATCH /api/v1/servers/{sc}` (L387) — renomeia/altera versão e descrição.
- `PUT .../slug` e `.../connect-name` (L1149, L1211) exigem *algum* assinante Plus, **não o dono**: qualquer assinante sequestra o link/endereço de qualquer servidor cujo código conheça. `DELETE` das mesmas rotas (L1190, L1249) exige só estar logado.
- `POST /api/v1/servers` (L342): se o `shortCode` enviado já existe, **sobrescreve nome/versão/loader** (ramo "retry", L352-368). Sem validação de tamanho/charset do `shortCode`, `name`, `description` e sem rate limit → dá para entupir o KV.
- `POST .../heartbeat` e `PATCH /api/servers/{sc}/status` (L312, L1476): qualquer um falsifica status/jogadores de qualquer servidor.

**Correção:** o `POST /servers` devolver um `ownerSecret` (guardado em `cubicase-meta.json`, hash no KV) exigido em todas as rotas de dono (delete/patch/regenerate/heartbeat/slug/connect-name/sessão de host). O convidado só precisa de `GET` + sessão de guest.

### 2. Qualquer pessoa com o código pode se passar pelo host (e travar o host de verdade) — `index.ts:563-610, 627-635`
`POST /connection-sessions` aceita `mode:"host"` de qualquer um que tenha o código: minta uma authKey `tag:cf-host` e, se o host real estiver offline/dormindo, o impostor segura a vaga (o dono real toma `409 OPERATION_IN_PROGRESS`) e, via `PATCH` com `hostIp`, **faz os convidados descobrirem o IP dele** (`handleDiscoverServer` lê `cs.hostIp`). Convidados entram num servidor falso (phishing, chat, mundo).

### 3. Um convidado consegue derrubar o dispositivo do host na malha — `index.ts:627-635` + `663-680`
O `PATCH` de uma sessão aceita `hostIp` arbitrário e resolve o `tailscaleDeviceId` **só pelo IP** (`findTailscaleDeviceByIp`). O IP do host é público (retornado por `GET /servers/{sc}`). Sequência: convidado cria a própria sessão → `PATCH hostIp=<IP do host>` → `DELETE` da sessão → o Worker chama `deleteTailscaleDevice` **no dispositivo do host** (ou de qualquer outro usuário). **Correção:** só aceitar o device cujo `hostname` seja o `cf-<mode>-<sid>` desta sessão.

### 4. Só um convidado por servidor ao mesmo tempo — `index.ts:578-582`
A chave `csession-by-shortcode:{sc}:guest` guarda **uma** sessão; se ela está `online/starting/waiting`, o segundo amigo recebe `409`. Não achei teste cobrindo 2 guests, nem tratamento no cliente. Também: se o convidado fecha o app sem avisar, o amigo (ou ele próprio, ao reconectar) fica bloqueado até a sessão expirar (~90–180 s). Para um produto "compartilhe com seus amigos" isso é central — **vale testar com 2 máquinas antes de qualquer outra coisa**. Correção: chave por `installationId`/sessionId, não por shortCode+mode, para guests.

### 5. Um host malicioso escreve arquivos em qualquer lugar do PC do convidado — `src/lib/modSync.ts:178-198` + `lib.rs:1411`
A lista de mods vem do host (JSON). `entry.filename` vai direto em `join(instanceModsDir, filename)` (aceita `..\..\`, caminho absoluto), a `url` é arbitrária e o `sha1` esperado **também vem do host** (verificação circular). `download_mod_file` não valida `dest_path` nem `url`. Um "amigo" com um código consegue largar `.bat` na pasta Startup do convidado = execução de código sem nem abrir o Minecraft. (O caminho de modpack já tem `safe_mod_filename` em `lib.rs:3931` — falta aplicar aqui.) **Correção:** validar `filename` (sem separador, `.jar`), restringir `url` a `https://cdn.modrinth.com` ou ao proxy loopback, e re-validar hash na API do Modrinth; no Rust, `download_mod_file`/`download_server_jar` devem restringir `dest_path` a diretórios conhecidos.

### 6. Backup do mundo pode falhar sempre com o servidor ligado e **substituir backups bons por zips quebrados** — `lib.rs:3323-3354`, `autoBackup.ts:90-123`
- `backup_world` não exclui `session.lock` (o `pack.rs:452` exclui, com motivo). No Windows o Java mantém esse arquivo travado → `io::copy` falha → o backup "de segurança" (que roda de propósito com o servidor ligado) falha. *Confirmar rodando com servidor online.*
- O zip é escrito direto em `<nome>.zip`, sem `.tmp` + rename, e o erro (`?`) não remove o parcial. Um zip truncado fica listado como backup. `pruneOldBackups` só roda após sucesso, mas quando um backup finalmente dá certo, a retenção mantém "os N mais novos" — **os parciais, mais novos, empurram os backups bons para fora**.
**Correção:** pular `session.lock`/`*.tmp`, escrever em `.tmp` e renomear, apagar o parcial em erro, e validar o zip antes de podar.

### 7. Sem política de privacidade, termos, licença nem aviso de marca — `docs/`, raiz
Há login (Supabase), pagamento (Stripe), coleta de e-mail no formulário de ajuda e um `installationId`, mas **não existe página de privacidade/termos** (os slugs até estão reservados no Worker), nem `LICENSE`, nem atribuição de licenças de terceiros (Tailscale/BSD, etc.), nem o aviso "não afiliado à Mojang/Microsoft". O `README.md` ainda é o do `create-next-app`. Exigido por LGPD/GDPR, pela Stripe e pela política de uso de marca do Minecraft.

### 8. EULA da Mojang aceito pelo usuário sem ele saber — `src/lib/server.ts:506` (e as cópias Forge/Fabric/Paper)
`eula.txt` é gravado com `eula=true` automaticamente; a UI de criação não mostra nem pede aceite (só a barra "Aceitando EULA..."). Precisa de um aceite explícito antes de criar o servidor.

---

## 🟠 Corrigir logo (antes ou logo depois do lançamento)

**Segurança**
- **Login por deep link sem proteção (login CSRF / fixação de sessão)** — `src/lib/auth.ts:44-53`. Qualquer página web pode abrir `cubicase://auth-callback#access_token=A&refresh_token=B` com tokens do atacante e o app faz `setSession`; a vítima passa a usar (e a assinar/parear dispositivo na) conta do atacante. Só aceitar o callback enquanto `requireAuth()` estiver pendente, com `state`/PKCE. Também: a URL com tokens vai para `console.error` (L48).
- **WebView sem CSP e com permissão de FS enorme** — `tauri.conf.json:22` (`"csp": null`) + `capabilities/default.json` (`fs:allow-write-text-file`, `read-text-file`, `read-dir`, `exists` com `"path": "**"`). Qualquer XSS futuro (mod description, nome de jogador, log) vira escrita de arquivo em qualquer pasta. Definir CSP e reduzir o escopo para `$APPLOCALDATA`/`$DOCUMENT/Cubicase*` (o que for externo passa por comandos Rust após seleção em diálogo).
- **Comandos Rust aceitam qualquer caminho/URL do frontend** (`download_server_jar`, `download_mod_file`, `extract_jre_zip`, `copy_local_mod_file`, `toggle_mod`/`delete_mod` sem validar `file_name`/`folder_name`). Hoje só o frontend chama, mas é a segunda linha de defesa para o item 5 e para o CSP.
- **Rede Tailscale compartilhada por todos**: a tag `cf-guest` é global, então um convidado do servidor A, sabendo/escaneando o IP `100.x` de um host B, alcança a porta 25565/25566 dele sem ter o código. **Confira a ACL** no admin do Tailscale (convidado só pode falar com host em 25565/25566; guest↔guest e host→qualquer negados). Não dá para verificar daqui.
- **`online-mode=false` por padrão** (`server.ts:563`): qualquer um que alcance o servidor entra com o nome de um OP. Combinado com o item acima, é sério. Documentar/oferecer whitelist por padrão.
- **Código curto gerado com `Math.random()`** (`server.ts:519`, e 4 cópias; alfabeto base36 com `0/O/1/I`, diferente do Worker). Como é a credencial, usar `crypto.getRandomValues` e deixar só o Worker gerar.
- `cmd.exe /c chcp 65001 & <java> <args>` (`lib.rs:1887-1898`): `jar_name`/`launch_args_dir` com `&`, `^` ou `%` (nome de .jar importado, usuário do Windows com `&`) é interpretado pelo cmd. Validar esses valores ou lançar o Java sem `cmd`.
- **Dependências**: `tailscale.com v1.70.0` (jun/2024) + Go 1.22 (fim de vida) compilando o binário que fica exposto à rede (`go.mod`, `release.yml`). `npm audit` raiz: 5 (1 crítica: `next`; é build/servidor Next, não roda no app estático, mas atualize para 16.3.x). API: 6 altas em `undici` (dev/test). Rodar `govulncheck` e `cargo audit`.
- Windows **sem assinatura de código** (nenhuma config de certificado em `tauri.conf.json`/CI) → SmartScreen "editor desconhecido" e mais falso-positivo de antivírus num app que sobe processos, abre PTY e baixa executáveis.

**Robustez**
- **Desligar o app mata o Minecraft após 5 s** (`lib.rs:5957`; "Parar" tem 15 s, `lib.rs:2784`). Mundo grande/com mods demora mais para salvar → `kill` no meio do save = chunks/`level.dat` corrompidos. Esperar o processo sair de verdade (30–60 s, com feedback).
- **Sidecar Go corta downloads de mod em 10 s** — `main.go:426-431`: `WriteTimeout: 10s` no servidor HTTP que serve `/mods/file` (proxy com timeout de 2 min). Mod de dezenas de MB em link lento é truncado a cada tentativa. Tirar o WriteTimeout (ou usar `http.ResponseController` por handler).
- `download_server_jar` carrega o arquivo **inteiro em memória** (`lib.rs:1249`, `response.bytes()`), sem teto de tamanho; `extract_jre_zip` sem limite de tamanho/entradas (`lib.rs:1314`) e apaga `extract_path` sem validar.
- `percent_decode` faz `&s[i+1..i+3]` em `str` (`lib.rs:4248`): `%` seguido de caractere multibyte entra em *panic* na thread da requisição (pedido de um convidado derruba aquela conexão; não o app). Trabalhar em bytes.
- Servidor HTTP local (`127.0.0.1:25567`) cria uma thread por requisição, sem limite, e responde `Access-Control-Allow-Origin: *` (`lib.rs:4226`). Um site aberto no navegador do host consegue consultar `/resolve` e `/mods` se souber o código. Remover o CORS (não é usado por navegador) e limitar concorrência. Porta fixa: se estiver ocupada, a falha só vai para `eprintln!` e a sincronização de mods some em silêncio.
- Arquivos de config do sidecar (`tsnet_<sessionId>.json`, com authKey) só são apagados no stop normal (`lib.rs:894`); o "Sair" pelo tray apaga um nome antigo (`tsnet_config.json`, `lib.rs:6000`). Ficam no AppData. Chave é de uso único/expira em 5 min, mas é lixo e superfície à toa.
- Webhook do Stripe sem ordenação (`index.ts:1110-1133`): evento antigo chegando atrasado (`updated`/`incomplete`) sobrescreve `active` e o usuário perde o Plus. Comparar `event.created` ou rebuscar a assinatura na API. `plan ?? 'monthly'` para preço desconhecido.
- Cota/custo do KV: cada host online grava ~3.300 chaves/dia (heartbeats de sessão + de status) e o rate limit é por escrita no KV; já houve estouro de cota (comentário L1448). Confirmar que a conta está no plano pago e ter alarme de uso.
- Tailscale: confira o limite de dispositivos do seu plano — cada host e cada convidado online ocupa um nó (efêmero) na mesma tailnet.

## 🟡 Registrar

- `restore_world_backup` extrai qualquer entrada do zip em `server_dir` (não só pastas de mundo) e `reset_world` não faz backup antes (clique único, irreversível).
- `send_minecraft_command` local não rejeita `\n` (só o painel web rejeita via `CONTROL_CHARS`); no modo "todos os comandos" do painel, `minecraft:stop` contorna a permissão "desligar".
- `createInvite` revela se um e-mail tem conta (limitado a 10/min/dono). `device_token` guardado em texto puro no Supabase (guardar hash).
- Janela de corrida no monitor do Minecraft ao reiniciar: o monitor antigo pode ler `minecraft_stop_requested` já resetado pelo novo start e emitir "crashed" falso.
- Loops `Accept()` do sidecar sem backoff/`ctx.Done()` (`main.go:194, 212`); sidecar morto à força deixa `%TEMP%\cubeforge-tsnet-*` (já citado antes).
- ESLint: 84 erros (quase todos `any`); o CI não roda lint. Corrigir ou rodar no CI.
- `cargo test` não foi rodado nesta revisão.
- Actions por tag mutável (`@v0`, `@v4`); fixar por SHA no workflow de release que assina o instalador.

## ✅ Pontos fortes (para não regredir)
Autorização do painel remoto reconstrói cada mensagem e rejeita caracteres de controle/nomes inválidos; tickets WS de uso único; `escapeHtml` consistente no site do painel; importação `.cubicase` com limites, symlinks e zip-slip testados; updater com chave pública; segredos fora do git (`.dev.vars` ignorado); escritas atômicas e rollback de restore corrigidos; JRE/jar verificados por SHA.

---

## Atualização — itens 1, 2, 3 e 5 corrigidos (mesmo dia)

- **1 e 2:** segredo de dono por servidor (`X-Owner-Secret`, hash SHA-256 em `owner:<código>` no KV). Exigido em delete/patch/regenerate/heartbeat/POST-retry/slug/connect-name e na sessão de rede em modo `host`. Servidores antigos (sem hash) são reivindicados pela 1ª chamada com segredo. Cliente: `src-tauri/src/owner_secret.rs` (AppData + espelho em `cubicase-meta.json`, campo `ownerSecret`). Cadastro agora valida `shortCode` (`[A-Z0-9]{4,12}`) e tamanhos.
- **3:** `PATCH` de sessão só aceita `hostIp` se o dispositivo Tailscale com aquele IP tiver o hostname daquela sessão; status/jogadores validados.
- **5:** `sanitizeRemoteMods`/`isSafeModFilename` (modSync.ts), URL de mod "modrinth" resolvida pela própria Modrinth via hash, e `download_mod_file` (Rust) só aceita `cdn.modrinth.com` ou `127.0.0.1:25568` e destino `.jar` sem `..`.
- Testes novos: 4 na API, 1 arquivo no frontend (`modSync.test.ts`), 3 no Rust. Tudo verde (API 97, frontend 161, Rust 163).
- **Pendente de deploy/observação:** publicar o Worker junto com a nova versão do app. App antigo falha nas rotas de dono (401). Servidor cujo segredo se perder (pasta sem `ownerSecret` + AppData limpo) fica trancado para o dono — o fluxo de recuperação ainda não existe.

- **Item 4 corrigido (confirmado em teste real: o 2º convidado recebia 409):** vaga de sessão por papel — 1 host por servidor e **1 convidado por instalação** (`csession-by-install:<código>:<installationId>`). Reconectar substitui a sessão antiga (revoga a key) em vez de dar 409, inclusive para o host. Apagar/regenerar derruba todos os convidados (lista por prefixo). `JOIN_RATE_LIMIT` 10 -> 30/min por IP (amigos na mesma rede). Cliente: não repete mais chamada em erro definitivo (429/403/404/400) — antes eram 9 pedidos por clique e estourava o limite. Testes novos no Worker (Tailscale simulado).

---

## Atualização — 2026-10-06 (itens 6, 7, 8 e correções 🟠)

- **Item 6 (backup):** `backup_world` não inclui mais `session.lock`/`*.tmp`; grava em `<nome>.zip.tmp`, relê o zip e só então renomeia; apaga parciais e restos de tentativas interrompidas. 2 testes novos.
- **Item 7 (legal):** páginas geradas por `scripts/build-legal-pages.mjs` — `/privacidade/`, `/termos/`, `/licencas/` e `/en/privacy/`, `/en/terms/`, `/en/licenses/`; rodapé com links e aviso de não afiliação em todas as páginas do site; link nos termos/privacidade na tela de login do site e na Central de Ajuda do app; README reescrito. **Pendentes (decisão do autor):** licença do código (LICENSE), nome/contato jurídico definitivos nas páginas, revisão por advogado, lista completa de licenças (gerar com `cargo about`/`license-checker` antes do release).
- **Item 8 (EULA):** `eula=true` só é gravado depois do aceite explícito (caixa nos fluxos Criar servidor, Importar modpack e Importar pacote; pergunta uma vez e fica registrado em `eulaAcceptedAt`).
- **🟠 corrigidos:** desligar o app espera até 60 s o Minecraft salvar (parada normal: 45 s); sidecar sem `WriteTimeout` de 10 s (downloads de mod); login por deep link com `state` aleatório de uso único (anti login-CSRF; a página `/entrar/` devolve o `state`); `percent_decode` sem panic; sem CORS `*` no servidor local; configs `tsnet_*.json` apagadas no desligamento e no boot; códigos curtos gerados com `crypto.getRandomValues`.
- **Ainda abertos (🟠):** CSP e escopo de FS do WebView, atualização do Tailscale/Go, `online-mode=false` por padrão, assinatura de código do Windows.
