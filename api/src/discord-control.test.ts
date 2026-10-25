// ============================================================
// Discord: o que cada comando de controle pode mandar ao app do host
// ============================================================

import { describe, it, expect } from "vitest";
import { planControl, validBackupNotify, backupResultMessage, type ControlAction } from "./discord-control";

const CODE = "ABC123";
const LOCAL_ID = "uuid-local-do-app"; // o app tem o próprio uuid; só o código (shortCode) é comum com a central
const TARGET = { shortCode: CODE, name: "Mundo" };
const status = (running: boolean) => JSON.stringify({ type: "status", serverRunning: running });
const list = (mine: "running" | "stopped", other: "running" | "stopped" = "stopped") =>
  JSON.stringify({
    type: "server_list",
    servers: [
      { id: LOCAL_ID, name: "Mundo", shortCode: CODE, status: mine },
      { id: "outro", name: "Outro", shortCode: "ZZZ999", status: other },
    ],
  });
const plan = (action: ControlAction, st: string | null, ls: string | null) => planControl(action, TARGET, st, ls);

describe("planControl", () => {
  it("ligar: manda start_server com o id que o app usa e espera a mudança", () => {
    expect(plan({ kind: "start" }, status(false), list("stopped"))).toEqual({
      ok: true, messages: [{ type: "start_server", serverId: LOCAL_ID }], expect: "start", restartServerId: null,
    });
  });

  it("acha o servidor pelo código da central, sem diferenciar maiúsculas", () => {
    const lower = JSON.stringify({ servers: [{ id: LOCAL_ID, name: "Renomeado", shortCode: CODE.toLowerCase(), status: "stopped" }] });
    expect(plan({ kind: "start" }, status(false), lower)).toMatchObject({ ok: true, messages: [{ serverId: LOCAL_ID }] });
  });

  it("app antigo, sem código na lista: aceita o nome só se for único", () => {
    const old = JSON.stringify({ servers: [{ id: LOCAL_ID, name: "mundo", status: "stopped" }, { id: "x", name: "Outro", status: "stopped" }] });
    expect(plan({ kind: "start" }, status(false), old)).toMatchObject({ ok: true, messages: [{ serverId: LOCAL_ID }] });
    const dup = JSON.stringify({ servers: [{ id: "a", name: "Mundo", status: "stopped" }, { id: "b", name: "Mundo", status: "stopped" }] });
    expect(plan({ kind: "start" }, status(false), dup)).toEqual({ ok: false, reason: "server_gone" });
  });

  it("um servidor com outro código nunca é confundido pelo nome", () => {
    const other = JSON.stringify({ servers: [{ id: "a", name: "Mundo", shortCode: "ZZZ999", status: "stopped" }] });
    expect(plan({ kind: "start" }, status(false), other)).toEqual({ ok: false, reason: "server_gone" });
  });

  it("ligar não passa por cima de outro servidor nem repete o que já está ligado", () => {
    expect(plan({ kind: "start" }, status(true), list("stopped", "running"))).toEqual({ ok: false, reason: "other_running" });
    expect(plan({ kind: "start" }, status(true), list("running"))).toEqual({ ok: false, reason: "already_running" });
  });

  it("desligar só vale se É este servidor que está rodando", () => {
    expect(plan({ kind: "stop" }, status(true), list("stopped", "running"))).toEqual({ ok: false, reason: "other_running" });
    expect(plan({ kind: "stop" }, status(false), list("stopped"))).toEqual({ ok: false, reason: "not_running" });
    expect(plan({ kind: "stop" }, status(true), list("running"))).toMatchObject({ ok: true, messages: [{ type: "stop_server" }], expect: "stop" });
  });

  it("reiniciar pede a parada e deixa a subida para o canal (duas etapas)", () => {
    expect(plan({ kind: "restart" }, status(true), list("running"))).toEqual({
      ok: true, messages: [{ type: "stop_server" }], expect: "restart", restartServerId: LOCAL_ID,
    });
    expect(plan({ kind: "restart" }, status(false), list("stopped"))).toEqual({ ok: false, reason: "not_running" });
  });

  it("whitelist vira o comando exato e recusa nomes que escapariam dele", () => {
    const ok = plan({ kind: "whitelist", op: "add", player: "Ana_01" }, status(true), list("running"));
    expect(ok).toMatchObject({ ok: true, messages: [{ type: "command", command: "whitelist add Ana_01" }], expect: null });
    for (const player of ["Ana op", "Ana\nop Bia", "Ana;stop", "", "x".repeat(33), "Ana*"]) {
      expect(plan({ kind: "whitelist", op: "add", player }, status(true), list("running"))).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("console passa o comando, mas rejeita caracteres de controle e textos longos", () => {
    expect(plan({ kind: "console", command: "say oi" }, status(true), list("running"))).toMatchObject({ ok: true, messages: [{ type: "command", command: "say oi" }] });
    expect(plan({ kind: "console", command: "say a\nstop" }, status(true), list("running"))).toEqual({ ok: false, reason: "invalid" });
    expect(plan({ kind: "console", command: "say " + "x".repeat(300) }, status(true), list("running"))).toEqual({ ok: false, reason: "invalid" });
  });

  it("'stop' digitado no console conta como desligar (não notifica o autor)", () => {
    expect(plan({ kind: "console", command: "stop" }, status(true), list("running"))).toMatchObject({ ok: true, expect: "stop" });
  });

  it("sem notícia do agent ou sem o servidor na lista, não adivinha", () => {
    expect(plan({ kind: "start" }, null, list("stopped"))).toEqual({ ok: false, reason: "unknown_state" });
    expect(plan({ kind: "start" }, status(false), null)).toEqual({ ok: false, reason: "unknown_state" });
    expect(plan({ kind: "start" }, status(false), JSON.stringify({ servers: [{ id: "outro", name: "Outro", shortCode: "ZZZ999", status: "stopped" }] }))).toEqual({ ok: false, reason: "server_gone" });
    expect(plan({ kind: "start" }, "isto não é json", list("stopped"))).toEqual({ ok: false, reason: "unknown_state" });
  });
});

describe("planControl: backup", () => {
  it("vale com o servidor ligado ou desligado, e manda o id que o app usa", () => {
    for (const mine of ["running", "stopped"] as const) {
      expect(plan({ kind: "backup" }, status(mine === "running"), list(mine))).toEqual({
        ok: true, messages: [{ type: "backup", serverId: LOCAL_ID }], expect: null, restartServerId: null,
      });
    }
  });

  it("não é barrado por outro servidor ligado, mas precisa achar este servidor", () => {
    expect(plan({ kind: "backup" }, status(true), list("stopped", "running"))).toMatchObject({ ok: true });
    expect(plan({ kind: "backup" }, status(false), JSON.stringify({ servers: [{ id: "x", name: "Outro", shortCode: "ZZZ999", status: "stopped" }] }))).toEqual({ ok: false, reason: "server_gone" });
    expect(plan({ kind: "backup" }, null, list("stopped"))).toEqual({ ok: false, reason: "unknown_state" });
  });
});

describe("resultado do backup de volta ao Discord", () => {
  const TOKEN = "a".repeat(60);

  it("só aceita o formato exato de id do aplicativo e token (a URL do Discord é montada com eles)", () => {
    expect(validBackupNotify({ appId: "123456789012345678", token: TOKEN, lang: "pt", user: "ana" })).toEqual({ appId: "123456789012345678", token: TOKEN, lang: "pt", user: "ana" });
    for (const bad of [
      null, "x", {}, { appId: "12", token: TOKEN },
      { appId: "123456789012345678", token: "curto" },
      { appId: "123456789012345678", token: TOKEN + "/../x" },
      { appId: "123456789012345678", token: TOKEN + "?a=b" },
      { appId: "1234567890/../", token: TOKEN },
    ]) {
      expect(validBackupNotify(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("limpa o nome de quem pediu e assume português se o idioma for estranho", () => {
    const n = validBackupNotify({ appId: "123456789012345678", token: TOKEN, lang: "fr", user: "**@everyone**\n`x`" });
    expect(n?.user).toBe("everyonex");
    expect(n?.lang).toBe("pt");
  });

  it("sucesso mostra o arquivo e o tamanho", () => {
    const msg = backupResultMessage({ lang: "pt", user: "ana" }, { ok: true, fileName: "world_1.zip", sizeBytes: 631 * 1024 * 1024 });
    expect(msg).toContain("concluído");
    expect(msg).toContain("`world_1.zip`");
    expect(msg).toContain("631 MB");
    expect(backupResultMessage({ lang: "en", user: "ana" }, { ok: true, fileName: "w.zip", sizeBytes: 3 * 1024 ** 3 })).toContain("3.0 GB");
  });

  it("falha mostra o motivo, sem quebra de linha nem crase solta", () => {
    const msg = backupResultMessage({ lang: "pt", user: "ana" }, { ok: false, error: "Já houve\num backup" });
    expect(msg).toContain("falhou");
    expect(msg).toContain("Já houve um backup");
    expect(msg).not.toContain("\n");
    expect(backupResultMessage({ lang: "pt", user: "ana" }, { ok: true })).toContain("falhou"); // resposta incompleta não vira sucesso
    expect(backupResultMessage({ lang: "pt", user: "ana" }, { ok: true, fileName: "a`b.zip", sizeBytes: 1 })).toContain("a'b.zip");
  });
});
