import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  // Vários arquivos rodam em paralelo (e o servidor do GitHub é mais lento que um PC): 5 s de padrão estourava em testes
  // que fazem dezenas de requisições seguidas. Isto só dá folga; não mascara travamento de verdade.
  test: { testTimeout: 30_000 },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      // Segredos de teste do transporte P2P (em produção vêm de `wrangler secret put`).
      miniflare: {
        bindings: {
          LINK_TOKEN_SECRET: "segredo-de-teste-do-link-0123456789",
          LINK_MAX_GUESTS: "3",
          STRIPE_WEBHOOK_SECRET: "whsec_segredo_de_teste",
          // Par Ed25519 só de teste: a chave privada correspondente está em src/discord.test.ts.
          DISCORD_PUBLIC_KEY: "67efa1cf3861cfdf7f81347a85d88f5f2e9aa60c20ae81df51642fce1a0d6fef",
          DISCORD_APP_ID: "123456789012345678",
        },
      },
    }),
  ],
});
