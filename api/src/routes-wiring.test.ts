// ============================================================
// As rotas novas (membros, denúncia, imagens de perfil) estão ligadas no roteador principal?
// ============================================================
// Os testes de cada módulo chamam o módulo direto; estes passam pelo Worker inteiro (SELF), que foi onde uma rota
// ficou sem ligação e respondeu 404 em produção.
//
// Na bateria de testes não há chave do Supabase, então o módulo que recebe a rota responde 503 ("não configurado")
// antes de pedir login; em produção a mesma rota responde 401. Para o roteador, o que importa é NÃO ser 404 (o
// "endpoint não encontrado" do fim do roteador): 401 ou 503 provam que a rota chegou ao módulo.
// ============================================================

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "https://example.com";
const call = (method: string, path: string, init: RequestInit = {}) => SELF.fetch(`${BASE}${path}`, { method, ...init });

/** A rota chegou ao módulo (não caiu no 404 do roteador). */
const reached = (status: number) => [401, 403, 503].includes(status);

describe("roteador principal", () => {
  it("membros: lista, entrar, sair e registrar em lote chegam ao módulo", async () => {
    expect(reached((await call("GET", "/api/v1/servers/ABC123/members")).status)).toBe(true);
    expect(reached((await call("POST", "/api/v1/servers/ABC123/members/me")).status)).toBe(true);
    expect(reached((await call("DELETE", "/api/v1/servers/ABC123/members/me")).status)).toBe(true);
    expect(reached((await call("PUT", "/api/v1/memberships", { body: JSON.stringify({ shortCodes: [] }) })).status)).toBe(true);
  });

  it("denúncia de perfil chega ao módulo (esta foi a rota que ficou sem ligação)", async () => {
    const r = await call("POST", "/api/v1/servers/ABC123/members/0123456789ab/report", { body: JSON.stringify({ reason: "image" }) });
    expect(reached(r.status)).toBe(true);
  });

  it("uma rota parecida mas fora do formato continua sendo 404", async () => {
    expect((await call("POST", "/api/v1/servers/ABC123/members/zzz/report")).status).toBe(404);
  });

  it("imagens de perfil: enviar e remover chegam ao módulo; servir pelo hash responde 404 da própria rota", async () => {
    expect(reached((await call("PUT", "/api/v1/profile/me/avatar", { body: "x" })).status)).toBe(true);
    expect(reached((await call("PUT", "/api/v1/profile/me/banner", { body: "x" })).status)).toBe(true);
    expect(reached((await call("DELETE", "/api/v1/profile/me/avatar")).status)).toBe(true);
    const missing = await call("GET", `/api/v1/profile-image/${"0".repeat(32)}`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("Not found"); // a resposta da rota de imagens, não a do "endpoint não encontrado"
  });

  it("denúncias do painel não devolvem dados sem o token do dono", async () => {
    // sem ADMIN_TOKEN configurado o painel responde 404; com ele, 401. Nos dois casos nunca devolve dados.
    const r = await call("GET", "/api/v1/admin/profile-reports");
    expect([401, 404]).toContain(r.status);
  });
});
