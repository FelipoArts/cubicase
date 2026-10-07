import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      // Segredos de teste do transporte P2P (em produção vêm de `wrangler secret put`).
      miniflare: {
        bindings: {
          LINK_TOKEN_SECRET: "segredo-de-teste-do-link-0123456789",
          TURN_SECRET: "segredo-turn-de-teste",
          LINK_MAX_GUESTS: "3",
          TURN_URLS: "turn:turn.exemplo.test:3478,turns:turn.exemplo.test:443?transport=tcp",
        },
      },
    }),
  ],
});
