# Testar o painel web localmente (ponta a ponta)

Sobe o relay (Worker), o painel e o app Cubicase na sua máquina, sem publicar nada.
Para só ver a interface com dados falsos, use `node scripts/panel-harness.mjs` (ver cabeçalho do script).

## Pré-requisitos

- O computador já está **pareado** com o painel (existe `panel_device.json` na pasta de dados do app) e a conta tem Cubicase Plus ativo.
- `api/.dev.vars` existe (já usado pelos testes) com `SUPABASE_SERVICE_ROLE_KEY`.
- No Supabase (Authentication → URL Configuration → Redirect URLs) adicione `http://localhost:4173/**`.
  Sem isso o login por Google/Discord/link mágico no painel local volta para o site de produção.

> O Worker local usa o **mesmo Supabase de produção** (chave de serviço do `.dev.vars`): o login e a validação do
> `device_token` são reais, e `last_seen_at` do seu dispositivo é atualizado. O estado do relay (cache de status,
> lista de jogadores) fica só na sua máquina.

## Passo a passo — 3 terminais

1. Relay local:

   ```bash
   cd api && npx wrangler dev
   ```

   Sobe em `http://localhost:8787`.

2. Painel (versão real, sem dados falsos):

   ```bash
   node scripts/panel-harness.mjs live
   ```

   Abra **http://localhost:4173/?relay=http://localhost:8787** e faça login.
   O `?relay=` só funciona quando a página está em localhost e o relay também.

3. App apontando para o relay local (variável lida só em build de desenvolvimento):

   PowerShell:

   ```powershell
   $env:CUBICASE_PANEL_RELAY_WS = "ws://localhost:8787/panel/ws"; npm run tauri dev
   ```

   Git Bash:

   ```bash
   CUBICASE_PANEL_RELAY_WS=ws://localhost:8787/panel/ws npm run tauri dev
   ```

   No log do app (`[PANEL] Conectado ao painel web remoto.`) e no terminal do `wrangler dev` você vê a conexão do agent.

## Roteiro de verificação

Com um servidor de teste **rodando** e pelo menos um jogador conectado (pode ser você mesmo):

| # | O que fazer | O que esperar |
|---|-------------|---------------|
| 1 | Abrir o computador no painel | Card "Jogadores online" com os nomes e as cabeças |
| 2 | Entrar/sair com um segundo jogador | A lista muda em até ~5s |
| 3 | Clicar em **Atualizar** | Aparece `list` no console e a lista reconcilia (valida o formato do `list` da sua versão) |
| 4 | **Expulsar** um jogador | Console: `> kick Nome (via painel web)`; jogador cai; sai da lista |
| 5 | **Banir** com motivo | `ban Nome motivo` no console; o jogador não consegue reentrar; desfazer com `pardon Nome` |
| 6 | Dois cliques rápidos em Expulsar | Só um comando no console |
| 7 | Parar o servidor | Lista some, aviso "O servidor está parado." |
| 8 | Convidar uma segunda conta como **Moderador** | Vê Expulsar habilitado e Banir desabilitado; a lista aparece (tem "ver console") |
| 9 | Convidar como **Visualizador sem console** (perfil personalizado) | Não vê nomes, só a contagem no topo |
| 10 | Fechar o app com o painel aberto | "Computador desconectado." e nenhuma lista velha |

Versão antiga: abrir o painel local com um app **sem** esta mudança deve mostrar, após ~8s, só a contagem com o aviso de atualizar o Cubicase.

## Voltar ao normal

Nada fica alterado: sem a variável de ambiente o app usa o relay de produção, e sem `?relay=` o painel também.
