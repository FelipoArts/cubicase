import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { parseFeedback, buildFeedbackEmail, sendFeedbackEmail, feedbackFingerprint } from "./feedback";

const BASE = "https://example.com";
const valid = { category: "bug", subject: "Servidor não abre", message: "Clico em iniciar e nada acontece.", email: "fulano@exemplo.com", appVersion: "0.3.9", os: "Windows 11", locale: "pt-BR" };

function post(body: unknown, raw = false) {
  return SELF.fetch(`${BASE}/api/v1/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": `10.0.0.${Math.floor(Math.random() * 250)}` },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

describe("parseFeedback", () => {
  it("aceita um relato válido e normaliza espaços", () => {
    const r = parseFeedback({ ...valid, subject: "  Servidor   não abre  " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.subject).toBe("Servidor não abre");
  });

  it.each([
    [{ ...valid, category: "xyz" }, "category"],
    [{ ...valid, subject: "ab" }, "subject"],
    [{ ...valid, subject: "a".repeat(121) }, "subject"],
    [{ ...valid, message: "curta" }, "message"],
    [{ ...valid, message: "a".repeat(4001) }, "message"],
    [{ ...valid, email: "sem-arroba" }, "email"],
    [{ ...valid, email: "a@b.com\nBcc: x@y.com" }, "email"],
    [null, "category"],
  ])("recusa %j -> campo %s", (input, field) => {
    const r = parseFeedback(input);
    expect(r).toEqual({ ok: false, field });
  });

  it("marca honeypot preenchido", () => {
    const r = parseFeedback({ ...valid, website: "http://spam" });
    expect(r.ok && r.value.honeypot).toBe(true);
  });
});

describe("e-mail", () => {
  it("monta assunto e corpo com tipo, e-mail e versão", () => {
    const r = parseFeedback(valid);
    if (!r.ok) throw new Error("inválido");
    const mail = buildFeedbackEmail(r.value);
    expect(mail.subject).toBe("[Cubicase] [Bug] Servidor não abre");
    expect(mail.text).toContain("fulano@exemplo.com");
    expect(mail.text).toContain("Versão do app: 0.3.9");
  });

  it("envia ao Resend com Reply-To do usuário e devolve false em erro", async () => {
    const r = parseFeedback(valid);
    if (!r.ok) throw new Error("inválido");
    let sent: any;
    const fake = (async (_u: string, init: RequestInit) => { sent = JSON.parse(init.body as string); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    expect(await sendFeedbackEmail({ RESEND_API_KEY: "k", FEEDBACK_TO_EMAIL: "dono@x.com" }, r.value, fake)).toBe(true);
    expect(sent.to).toEqual(["dono@x.com"]);
    expect(sent.reply_to).toBe("fulano@exemplo.com");
    const bad = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    expect(await sendFeedbackEmail({ RESEND_API_KEY: "k", FEEDBACK_TO_EMAIL: "dono@x.com" }, r.value, bad)).toBe(false);
    const boom = (async () => { throw new Error("rede"); }) as unknown as typeof fetch;
    expect(await sendFeedbackEmail({ RESEND_API_KEY: "k", FEEDBACK_TO_EMAIL: "dono@x.com" }, r.value, boom)).toBe(false);
  });

  it("fingerprint é estável e ignora caixa do e-mail", async () => {
    const a = parseFeedback(valid), b = parseFeedback({ ...valid, email: "FULANO@exemplo.com" });
    if (!a.ok || !b.ok) throw new Error("inválido");
    expect(await feedbackFingerprint(a.value)).toBe(await feedbackFingerprint(b.value));
  });
});

describe("POST /api/v1/feedback", () => {
  it("400 com JSON inválido", async () => {
    expect((await post("{nope", true)).status).toBe(400);
  });

  it("400 com campo inválido e diz qual", async () => {
    const res = await post({ ...valid, email: "x" });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.details).toEqual({ field: "email" });
  });

  it("honeypot responde sucesso sem exigir configuração de e-mail", async () => {
    const res = await post({ ...valid, website: "spam" });
    expect(res.status).toBe(200);
  });

  it("503 quando o envio de e-mail não está configurado", async () => {
    const res = await post(valid);
    expect(res.status).toBe(503);
  });

  it("bloqueia rajada do mesmo IP (rate limit)", async () => {
    const send = () => SELF.fetch(`${BASE}/api/v1/feedback`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.9" }, body: JSON.stringify({ ...valid, website: "x" }) });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await send()).status);
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[4]).toBe(429);
  });
});
