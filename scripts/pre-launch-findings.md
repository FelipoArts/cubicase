# Achados de revisão pré-lançamento (2026-09-28)

Revisão de robustez feita em cima do estado atual do código (não é o
checklist manual de execução — ver [`mc-lifecycle-checklist.md`](mc-lifecycle-checklist.md)
para isso). Cobriu: rede/mesh/sync com a API Central, download de
JRE/server.jar/instaladores de mod loader, operações de arquivo do
mundo/servidor, e o estado do frontend. Metodologia: 4 subagentes em
paralelo, cada um só reportando achados com cenário concreto de
disparo (arquivo:linha + sequência de eventos + o que quebra pro
usuário) — sem "poderia ser mais robusto" genérico.

**Como ler:** 🔴 P0 = acho que bloqueia lançamento (perda de dado, dado
corrompido, ou fluxo central quebrado sem contorno). 🟠 P1 = bug real,
vale corrigir logo, mas tem contorno ou é mais raro. 🟡 P2 = registrar
pra depois.

---

## 🔴 P0 — Bloqueadores

### 1. "Resetar Mundo" pode apagar uma pasta arbitrária da máquina do usuário
`read_level_name` (lib.rs:2942) lê `level-name=` do `server.properties`
sem validar nada, e `world_folder_paths`/`reset_world`/`backup_world`/
`restore_world_backup` fazem `PathBuf::join(server_dir, level_name)` direto.
`PathBuf::join` **substitui o caminho inteiro** se o valor for absoluto
(`level-name=C:\Users\Alguem\Documents`) ou usa `..` pra escapar do
diretório. Sem `canonicalize()` + `starts_with(server_dir)` em lugar
nenhum. Um usuário editando `server.properties` manualmente (ou
importando um servidor com esse arquivo já alterado) e clicando
"Resetar Mundo" — um botão de um clique — apaga recursivamente
qualquer pasta que aquele valor resolva.

### 2. Restaurar backup pode apagar o mundo original do usuário
`restore_world_backup` (lib.rs:3229) move o mundo atual pra uma pasta
de staging, extrai o backup, e se a extração falhar tenta desfazer —
mas tanto o "desfazer" quanto o cleanup final ignoram erro (`let _ =`).
Se um antivírus estiver com um handle aberto num arquivo (cenário comum
logo após extrair), o rollback falha silenciosamente e a linha
seguinte **apaga a pasta de staging de qualquer forma** — que é onde o
mundo original do usuário estava guardado. Resultado: perde o backup
que falhou E o mundo original, com um erro genérico de "falha na
extração".

### 3. Escrita de `server.properties`/whitelist/ops/bans não é atômica
`write_server_properties` e `write_json_list` (usado por
whitelist/ops/bans) fazem `std::fs::write` direto, sem arquivo
temporário + rename. Se o processo for morto ou o disco encher no meio
da escrita (plausível numa máquina também rodando uma JVM consumindo
RAM), o arquivo fica truncado/vazio — pode apagar a whitelist inteira
silenciosamente ou impedir o servidor de subir.

### 4. O bug de "trava para sempre" já documentado só foi corrigido em UM dos dois caminhos que o disparam
Existe um comentário no próprio `lib.rs` relatando um teste real onde
`session_manager.start()` travou por minutos sem completar nem falhar,
só destravando com F5. O conserto (timeout de 45s + retry) foi aplicado
em `wake_from_sleep` (Cubicase Plus), mas **não** no clique normal de
"Hospedar"/"Entrar" (`start_network_node`, chamado direto sem timeout em
`page.tsx`/`HostView.tsx`). Ou seja, o bug que motivou aquele incidente
continua ativo no fluxo que todo usuário usa.

### 5. Botão Iniciar/Parar pode travar permanentemente desabilitado
`HostView.tsx` marca `serverStatus` como `"stopping"` otimisticamente
antes de chamar `stop_minecraft_server`; se o comando falhar (IPC, processo
já morto, panic), o catch só loga — nunca reverte o status. Como o botão
fica desabilitado em `"starting"`/`"stopping"`, e nenhum evento vai
corrigir isso sozinho, o usuário fica sem conseguir iniciar ou parar o
servidor até reiniciar o app inteiro.

---

## 🟠 P1 — Deveriam ser corrigidos antes ou logo após o lançamento

**Download/instalação (JRE, jar, mod loaders):**
- Nenhuma verificação de integridade (SHA1/SHA256) no instalador do
  Forge/NeoForge nem no jar do Fabric (`server.ts` passa
  `expectedSha1: null`) — ao contrário de Vanilla/Paper e dos mods, que
  são verificados. Uma conexão truncada gera um erro opaco de "jar
  corrompido" sem indicar que foi o download.
- Dois servidores criados em sequência que precisam da mesma versão de
  Java disparam downloads concorrentes que compartilham o mesmo
  arquivo temporário — um pode apagar o que o outro está baixando.
- Clicar "Criar Servidor" duas vezes rápido (ou criar dois com o mesmo
  nome quase ao mesmo tempo) tem uma janela clássica de TOCTOU entre o
  `exists()` e o `mkdir()` — os dois passam pela checagem e escrevem no
  mesmo diretório.
- JRE corrompida por uma queda de energia/kill no meio da extração
  passa como "instalada" pra sempre (só checa se `java.exe` existe, não
  os arquivos de suporte).

**Mundo/arquivos:**
- O backup automático de segurança zipa o mundo **enquanto o
  Minecraft está escrevendo nele**, por design — pode capturar um
  arquivo `.mca` cortado no meio, e a restauração só confere se o zip
  abre, nunca se os dados dentro são válidos.
- "Servidor precisa estar parado" só é checado na UI, nunca nos
  comandos Rust — durante os estados `starting`/`stopping` (não só
  `online`), uma edição de whitelist/ops pode ser sobrescrita segundos
  depois pelo próprio servidor subindo/descendo.
- Excluir/desativar um mod não checa se o servidor está rodando — no
  Windows, o arquivo pode estar travado pelo processo Java.

**Rede/sync:**
- A fila de sincronização (`sync_register_server`/`update`/`delete`)
  carrega e salva o arquivo inteiro sem lock — uma operação nova
  enfileirada enquanto o processamento periódico está no meio de
  retentar operações antigas pode ser silenciosamente apagada.
- Registrar/atualizar/excluir servidor e o heartbeat não usam
  `requestId` (diferente da criação de ConnectionSession) — um retry
  automático pode duplicar ou mutar a identidade do servidor na API
  Central sem avisar ninguém.
- O retry de `set_online` gera um `requestId` novo a cada tentativa mas
  reusa a mesma `revision` — se uma resposta se perder depois de já ter
  sido aplicada no servidor, as tentativas seguintes tomam
  `STALE_WRITE` e o host fica marcado como `Degraded` permanentemente
  mesmo estando 100% online.

**Frontend:**
- O painel de logs de rede tem dois "donos" de estado (um `useState`
  local em `page.tsx` que escreve na mão no localStorage, e um campo
  homônimo no Zustand cuja ação `setLogs` nunca é chamada) — qualquer
  outra mutação do store (jogador entrando, log do console) sobrescreve
  o que acabou de ser salvo. Resultado: o log de rede não sobrevive a
  Ctrl+R, apesar do comentário no código dizer que deveria.
- Depois de um Ctrl+R com o servidor já `online`, o painel de Jogadores
  mostra ninguém conectado até cada jogador já presente gerar uma NOVA
  linha de "entrou/saiu" — não há como consultar quem já está
  conectado (sem RCON).
- Um `useEffect` de 300+ linhas que registra 7 listeners do Tauri tem
  `minecraftPort` como dependência sem nunca usá-lo — salvar a porta
  nas Configurações desmonta e remonta todos os listeners à toa,
  duplicando linhas de log; e esse mesmo efeito, ao contrário dos
  outros no mesmo arquivo, não tem a proteção contra corrida
  (`cancelled` flag), então nesse remount listeners podem vazar/duplicar.

**Diagnóstico (achado meu, revisão do ciclo de vida):**
- A thread de amostragem de RAM/CPU (`lib.rs:1989`) mede o PID errado
  no Windows: `mc_pid` vem do processo `cmd.exe` usado só como wrapper
  pra rodar `chcp 65001 & java...`, não do `java.exe` real. O
  `job_object::kill_process_tree` já resolve isso corretamente pra
  matar o processo (percorre os filhos), mas a amostragem não — então o
  `resource_snapshot` que aparece no diagnóstico de crash (feito
  justamente pra dizer "faltou RAM" vs. "seu PC não tem RAM") está
  medindo um processo praticamente ocioso, no Windows, que é a única
  plataforma que o app builda hoje.

---

## 🟡 P2 — Registrar para depois

- Mensagens de erro do instalador do Forge/Fabric não incluem o
  stdout/stderr real (só "código: Some(1)"); causa real fica só no log
  interno.
- `run_forge_installer` deixa o stdin aberto (piped, nunca fechado) —
  diferente dos instaladores de cliente, que usam `Stdio::null()`; se o
  instalador do Forge algum dia esperar entrada, trava até o timeout de
  10 min em vez de falhar rápido.
- Erros de disco cheio/permissão usam `e.to_string()` em vez do `tr!()`
  — usuário vê erro cru em inglês misturado numa UI em PT-BR.
- Fallback silencioso pra uma build diferente da escolhida se a
  selecionada sumir entre listar e instalar (Forge/NeoForge/Paper).
- Árvore de bibliotecas do Forge é profunda o bastante pra estourar o
  limite de 260 caracteres do Windows em caminhos de usuário longos.
- Chamadas `fetch()` do lado TypeScript (Mojang/Fabric/Forge/Paper) não
  têm timeout — podem travar a barra de progresso indefinidamente.
- `delete_mod`/`delete_world_backup`/`restore_world_backup` não validam
  o `file_name`/`folder_name` contra `..`/caminho absoluto no próprio
  comando Rust (hoje só não é explorável porque a UI só manda valores
  que ela mesma listou — mas não há contenção no servidor).
- `set_server_icon` decodifica a imagem inteira antes de checar
  tamanho/dimensão — uma imagem maliciosa pode estourar memória.
- `reset_world` não tem backup nem rollback — falha parcial (ex: um dos
  3 diretórios do mundo travado) deixa o mundo half-reset.
- Flag `network_stop_requested` é global, não por tentativa — duas
  transições de rede sobrepostas podem classificar errado um crash como
  parada normal (ou vice-versa).
- Falha de heartbeat é ignorada sem retry nem diagnóstico — 2 falhas
  seguidas (~2-3 min de instabilidade de rede) expiram a sessão na API
  Central em silêncio.
- Idle-shutdown pode derrubar um convidado que está no meio da conexão
  exatamente no tick do desligamento por inatividade.
- Loops de `Accept()` no sidecar Go não têm backoff nem checam
  `ctx.Done()` — um erro persistente vira loop apertado de CPU sem o
  Rust nunca perceber que o processo "morreu" logicamente.
- No Windows, `stop_network_node_internal` sempre mata o sidecar Go à
  força (`TerminateProcess`) — os `defer` de limpeza dele (inclusive
  apagar a pasta de estado temporária) nunca rodam, gerando acúmulo de
  pastas em `%TEMP%`.
- `wake_from_sleep` pode abandonar um sidecar no meio da subida se o
  timeout de 45s disparar bem naquela janela, deixando um processo
  órfão não rastreado.
- Histórico de console de um servidor excluído nunca é limpo — criar
  um novo servidor com o mesmo nome herda logs antigos (inclusive
  crashes antigos) misturados.
- A trava de "só tenta corrigir Java uma vez por sessão" reseta se o
  app reiniciar ou o efeito de listeners remontar (ver achado do
  `minecraftPort` acima) — pode entrar num loop de reinstalar a JRE
  repetidamente pra um crash que na verdade tem outra causa.
