# Cubicase

Crie e compartilhe servidores de Minecraft Java **no seu próprio computador**, sem abrir portas no roteador e sem configurar nada de rede.
*Create and share Minecraft Java servers on your own PC — no port forwarding, no networking setup.*

Site: <https://cubicase.net> · Tutorial: <https://cubicase.net/tutorial/> · English: <https://cubicase.net/en/>

> O Cubicase é um projeto independente. Não é afiliado, associado nem endossado pela Mojang Studios nem pela Microsoft. Minecraft é uma marca registrada da Mojang Synergies AB.

## O que faz

- Cria servidores Vanilla, Paper, Fabric, Forge e NeoForge em poucos cliques (baixa o servidor e o Java certos).
- Convida amigos por um **código curto** (ou link), sem port forwarding.
- Gerencia mundo (backups automáticos, restaurar), jogadores (whitelist, ops, bans), mods e modpacks (Modrinth + CurseForge).
- Exporta/importa servidores como pacote `.cubicase`.
- **Cubicase Plus** (opcional, assinatura): painel web remoto, servidor que acorda sob demanda, link e endereço de conexão personalizados.

## Como funciona (resumo)

| Peça | Tecnologia |
|---|---|
| App desktop | Tauri v2 (Rust) + Next.js (exportação estática) + React 19 + TypeScript + Zustand + Tailwind v4 |
| Rede host ⇄ convidado | P2P (WebRTC via Pion) no sidecar em Go `src-tauri/sidecars/cubicase-link`, com relay TURN (coturn) como reserva — ver `infra/relay/` |
| API central | Cloudflare Worker (`api/`): registro de servidores, sessões de rede, painel remoto (Durable Objects), assinaturas (Stripe) |
| Contas | Supabase |
| Site | `docs/` (estático, GitHub Pages) |

## Desenvolvimento

Pré-requisitos: Node 20+, Rust (stable), Go 1.22+, Visual Studio Build Tools (C++) e WebView2 no Windows. Detalhes em [`SETUP.md`](SETUP.md).

```bash
npm install
npm run build:sidecar     # compila o sidecar de rede (Windows)
npm run tauri dev         # app completo
npm run dev               # só a interface (sem recursos nativos)
```

Testes (rodam no CI a cada push):

```bash
npm test                  # backend (cargo) + frontend (vitest) + API (vitest/miniflare)
```

API (Cloudflare Worker):

```bash
cd api
npx wrangler dev          # local
npx wrangler deploy       # publicar (segredos via `wrangler secret put`)
```

Site e páginas legais:

```bash
npm run site:i18n                      # valida o dicionário e gera as páginas /en/ de index e download
node scripts/build-legal-pages.mjs     # gera privacidade, termos e licenças (PT e EN)
```

## Segurança

Para reportar uma vulnerabilidade, **não abra uma issue pública**: escreva para felipe@cubicase.net ou use a Central de Ajuda dentro do app (tipo "Problema"), descrevendo só o suficiente para entrarmos em contato.

## Privacidade e termos

- [Política de Privacidade](https://cubicase.net/privacidade/) · [Termos de Uso](https://cubicase.net/termos/) · [Licenças de terceiros](https://cubicase.net/licencas/)

## Licença

A licença do código do Cubicase ainda será definida pelo autor. Até lá, todos os direitos são reservados. Os componentes de terceiros mantêm suas próprias licenças (ver página de licenças acima).
