# Checklist manual — Ciclo de vida do servidor Minecraft

Checklist de pré-lançamento focado especificamente no fluxo mais frágil e
menos coberto por teste automatizado do Cubicase: iniciar, acompanhar e
parar um servidor Minecraft de verdade (`start_minecraft_server` /
`stop_minecraft_server_internal` em [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs)).

**Por que manual e não automatizado agora:** os bugs que esse código já
teve na prática (buffer do Forge travando o console, eco duplicado do
JLine, encoding quebrando acento no chat) só aparecem com Java/Forge de
verdade rodando sob o pseudo-terminal real — um harness automatizado com
processo falso não reproduziria nenhum deles. Ver decisão registrada na
sessão de 2026-09-28.

**Como usar:** marque cada item ao testar. Itens **P0** são os que
realmente bloqueiam o lançamento (caminho feliz + os 4 erros que o app já
sabe diagnosticar). Itens **P1** valem a pena mas não travam o lançamento
se o tempo apertar — priorize por cima deles se faltar tempo.

---

## P0 — Caminho feliz por tipo de servidor

Repita para cada `serverType` suportado (`vanilla`, `forge`, `neoforge`,
`fabric`, `paper` — ver `ServerType` em [`src/lib/server.ts:1587`](../src/lib/server.ts)).
Para cada um: criar → iniciar → ver "Done (" no console → parar limpo.

| # | Tipo | Criar | Iniciar (chega a "Done (") | Console mostra logs | "Parar" limpo (exit code 0, sem crash) |
|---|------|:---:|:---:|:---:|:---:|
| 1.1 | vanilla | [ ] | [ ] | [ ] | [ ] |
| 1.2 | forge | [ ] | [ ] | [ ] | [ ] |
| 1.3 | neoforge | [ ] | [ ] | [ ] | [ ] |
| 1.4 | fabric | [ ] | [ ] | [ ] | [ ] |
| 1.5 | paper | [ ] | [ ] | [ ] | [ ] |

Para cada linha, confira também:
- [ ] Status na UI muda `starting` → `online` → (ao parar) `stopping` → `offline`, sem ficar preso em nenhum estado
- [ ] Nenhum processo `java.exe` órfão sobra no Gerenciador de Tarefas depois do "Parar"

**Atenção especial (Forge/NeoForge):** são os únicos com a rota de
`@user_jvm_args.txt @.../win_args.txt` em vez de `-jar` direto (ver
`launch_args_dir` em `start_minecraft_server`) — se a criação desse
servidor não gerou esses arquivos corretamente, o Java falha na hora de
ler os `@arquivo`, então esse é o ponto mais provável de quebrar algo novo.

---

## P0 — Os 4 crashes que o app sabe diagnosticar

Cada um deve fazer a UI mostrar o diagnóstico certo (não o genérico "O
servidor Minecraft travou" — ver `detect_known_mc_error` em
[`lib.rs:1499`](../src-tauri/src/lib.rs)).

| # | Cenário | Como forçar | Diagnóstico esperado |
|---|---------|-------------|----------------------|
| 2.1 | RAM insuficiente | Alocar RAM muito baixa (ex: 128 MB) pra um servidor moderno | `out_of_memory` — "OutOfMemoryError" / heap space |
| 2.2 | Java incompatível | Apontar um JRE antigo (Java 8/11) pra um server 1.20+ (exige 17+) | `java_version_incompatible` — UnsupportedClassVersionError |
| 2.3 | Porta ocupada | Deixar outro processo (ex: `python -m http.server 25565`) escutando na porta antes de iniciar | Mensagem de porta ocupada **antes mesmo do Java subir** (retry de 4 tentativas, ~2s — ver `PORT_CHECK_ATTEMPTS`) |
| 2.4 | EULA não aceita | Editar `eula.txt` pra `eula=false` manualmente antes de iniciar | `eula_not_accepted` |

- [ ] 2.1 testado
- [ ] 2.2 testado
- [ ] 2.3 testado
- [ ] 2.4 testado — e depois disso, confirmar que criar um servidor novo pelo Cubicase continua aceitando o EULA automaticamente (regressão)

---

## P1 — Crash desconhecido / caminho de diagnóstico genérico

- [ ] 3.1 Force o encerramento do `java.exe` pelo Gerenciador de Tarefas (kill -9 equivalente) enquanto o servidor está `online`, sem ter clicado em "Parar" antes → app deve reportar `crashed` (não `offline`), com causa `unknown_crash` e a cauda do `logs/latest.log` anexada ao diagnóstico
- [ ] 3.2 Se o Minecraft/Forge gerar um `crash-reports/*.txt` de verdade (ex: crash de um mod incompatível), confirme que o texto desse arquivo aparece no diagnóstico (não só a cauda do log)
- [ ] 3.3 Parada solicitada pelo usuário, mas o processo não sai em até 15s (trave uma modal de confirmação no console do Java, se der pra simular, ou um mod que ignora `stop`) → app deve forçar o kill depois do timeout e ainda assim reportar `offline` (parada normal), não `crashed`

---

## P1 — Reinício e concorrência

- [ ] 4.1 Clicar "Iniciar" de novo enquanto já está `online` → deve parar o anterior sozinho e subir um novo (não deve dar erro nem deixar dois processos vivos)
- [ ] 4.2 Clicar "Parar" duas vezes seguidas rápido → não deve travar nem duplicar a lógica de kill
- [ ] 4.3 Fechar o Cubicase inteiro (não só parar o servidor) com o Minecraft `online` → o processo Java deve morrer junto (job object), não ficar órfão

---

## P1 — Console e encoding

- [ ] 5.1 Enviar comando com acento pelo console do Cubicase (ex: `say Olá, é hoje!`) → aparece certo no chat do jogo, sem virar `?` ou lixo
- [ ] 5.2 Jogador com acento no nome ou mensagem de chat com acento aparece certo no console do Cubicase
- [ ] 5.3 No Forge especificamente: comando enviado pelo console **não aparece duplicado** no log (era o bug do eco do JLine — ver `-Djline.terminal` / `TERM=dumb`)

---

## P1 — Importação de servidor existente

Repita ao menos para `vanilla` e um mod loader (ex: `forge`):

- [ ] 6.1 Importar servidor criado fora do Cubicase → tipo detectado corretamente na sidebar
- [ ] 6.2 Servidor importado inicia e chega a `online` normalmente
- [ ] 6.3 `eula.txt` é criado/corrigido para `eula=true` na importação

---

## P2 — Se sobrar tempo

- [ ] 7.1 Wake-on-demand: armar, deixar o servidor "dormir", conectar como guest e confirmar que acorda sozinho (`arm_wake_on_demand` / `spawn_sleeping_loop`)
- [ ] 7.2 Idle shutdown: servidor sem jogadores por tempo suficiente desliga sozinho quando wake-on-demand está armado
- [ ] 7.3 Sessão longa (30+ min) com jogadores entrando/saindo várias vezes — painel de Jogadores continua batendo com quem está de fato conectado

---

## Registro de resultados

Para cada item marcado com problema, anote aqui antes de decidir se
bloqueia o lançamento: tipo de servidor, versão do MC, versão do
loader, e o que aconteceu de diferente do esperado.

| Item | OK / Falhou | Observação |
|------|:---:|------------|
| | | |
