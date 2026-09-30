import { describe, it, expect } from "vitest";
import { validateFeedback, isValidEmail, sendFeedback, type FeedbackDraft } from "../feedback";

const ok: FeedbackDraft = { category: "bug", subject: "Não abre", message: "Clico em iniciar e nada acontece.", email: "a@b.com" };

function fakeFetch(status: number, body: unknown = {}): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("validateFeedback", () => {
  it("aceita um rascunho válido", () => expect(validateFeedback(ok)).toBeNull());
  it.each([
    [{ ...ok, category: "" }, "category"],
    [{ ...ok, subject: "  a " }, "subject"],
    [{ ...ok, message: "curto" }, "message"],
    [{ ...ok, message: "x".repeat(4001) }, "message"],
    [{ ...ok, email: "sem@ponto" }, "email"],
  ] as const)("recusa %#", (d, field) => expect(validateFeedback(d as FeedbackDraft)).toBe(field));
});

describe("isValidEmail", () => {
  it("valida formatos comuns e barra injeção de cabeçalho", () => {
    expect(isValidEmail("nome.sobrenome+tag@dominio.com.br")).toBe(true);
    expect(isValidEmail("a@b.com\nBcc: x@y.com")).toBe(false);
    expect(isValidEmail("a b@c.com")).toBe(false);
  });
});

describe("sendFeedback", () => {
  it("não chama a rede com rascunho inválido", async () => {
    let called = false;
    const f = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
    const r = await sendFeedback({ ...ok, email: "x" }, {}, f);
    expect(r).toEqual({ ok: false, reason: "validation", field: "email" });
    expect(called).toBe(false);
  });

  it("mapeia os status da API", async () => {
    expect(await sendFeedback(ok, {}, fakeFetch(200))).toEqual({ ok: true });
    expect(await sendFeedback(ok, {}, fakeFetch(429))).toEqual({ ok: false, reason: "rate" });
    expect(await sendFeedback(ok, {}, fakeFetch(503))).toEqual({ ok: false, reason: "unavailable" });
    expect(await sendFeedback(ok, {}, fakeFetch(502))).toEqual({ ok: false, reason: "server" });
    expect(await sendFeedback(ok, {}, fakeFetch(400, { details: { field: "message" } }))).toEqual({ ok: false, reason: "validation", field: "message" });
  });

  it("devolve 'network' quando o fetch falha", async () => {
    const f = (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
    expect(await sendFeedback(ok, {}, f)).toEqual({ ok: false, reason: "network" });
  });
});
