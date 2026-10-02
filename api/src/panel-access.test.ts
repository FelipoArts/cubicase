// ============================================================
// Testes do modelo de permissões do painel compartilhado
// ============================================================
// Lógica pura, sem Worker/KV — é a peça que decide se um membro convidado
// consegue ou não fazer algo no servidor de outra pessoa, então o que mais
// importa aqui é o que fica NEGADO (bypass por "stop" no console, quebra de
// linha, tipo de mensagem desconhecido...).
// ============================================================

import { describe, it, expect } from "vitest";
import {
  authorizePanelMessage,
  generateInviteToken,
  inviteUsable,
  normalizeAllowlistEntry,
  normalizePermissions,
  OWNER_PERMISSIONS,
  PERMISSION_PRESETS,
  type PanelPermissions,
} from "./panel-access";

const perms = (over: Partial<PanelPermissions> = {}): PanelPermissions => ({
  ...PERMISSION_PRESETS.viewer,
  ...over,
});

describe("normalizeAllowlistEntry", () => {
  it("tira a barra inicial, baixa a caixa e colapsa espaços", () => {
    expect(normalizeAllowlistEntry("  /Time   SET ")).toBe("time set");
  });
  it("recusa vazio, não-string, controle e entradas gigantes", () => {
    expect(normalizeAllowlistEntry("")).toBeNull();
    expect(normalizeAllowlistEntry("///")).toBeNull();
    expect(normalizeAllowlistEntry(42)).toBeNull();
    expect(normalizeAllowlistEntry("say\nstop")).toBeNull();
    expect(normalizeAllowlistEntry("a".repeat(61))).toBeNull();
  });
});

describe("normalizePermissions", () => {
  it("aceita os presets como estão", () => {
    for (const p of Object.values(PERMISSION_PRESETS)) {
      expect(normalizePermissions(p)).toEqual(p);
    }
  });
  it("só considera true estrito (string 'true' não vira permissão)", () => {
    const n = normalizePermissions({ viewConsole: "true", start: 1, stop: true, restart: false, commands: { mode: "none" } });
    expect(n).toMatchObject({ viewConsole: false, start: false, stop: true, restart: false });
  });
  it("descarta a whitelist fora do modo allowlist e deduplica dentro dele", () => {
    expect(normalizePermissions({ commands: { mode: "all", allowlist: ["say"] } })?.commands.allowlist).toEqual([]);
    expect(normalizePermissions({ commands: { mode: "allowlist", allowlist: ["Say", "/say", "kick"] } })?.commands.allowlist).toEqual(["say", "kick"]);
  });
  it("recusa modo allowlist vazio, modo desconhecido e entrada inválida", () => {
    expect(normalizePermissions({ commands: { mode: "allowlist", allowlist: [] } })).toBeNull();
    expect(normalizePermissions({ commands: { mode: "tudo" } })).toBeNull();
    expect(normalizePermissions({ commands: { mode: "allowlist", allowlist: ["say", ""] } })).toBeNull();
    expect(normalizePermissions({ commands: { mode: "allowlist", allowlist: Array.from({ length: 41 }, (_, i) => `c${i}`) } })).toBeNull();
    expect(normalizePermissions(null)).toBeNull();
    expect(normalizePermissions({})).toBeNull();
  });
});

describe("authorizePanelMessage — ligar/desligar/reiniciar", () => {
  it("cada ação depende só da própria permissão", () => {
    const onlyStart = perms({ start: true });
    expect(authorizePanelMessage(onlyStart, { type: "start_server", serverId: "abc" }).ok).toBe(true);
    expect(authorizePanelMessage(onlyStart, { type: "stop_server" }).ok).toBe(false);
    expect(authorizePanelMessage(onlyStart, { type: "restart_server", serverId: "abc" }).ok).toBe(false);

    const onlyStop = perms({ stop: true });
    expect(authorizePanelMessage(onlyStop, { type: "stop_server" }).ok).toBe(true);
    expect(authorizePanelMessage(onlyStop, { type: "start_server", serverId: "abc" }).ok).toBe(false);

    const onlyRestart = perms({ restart: true });
    expect(authorizePanelMessage(onlyRestart, { type: "restart_server", serverId: "abc" }).ok).toBe(true);
    expect(authorizePanelMessage(onlyRestart, { type: "stop_server" }).ok).toBe(false);
  });
  it("exige serverId válido para iniciar/reiniciar", () => {
    expect(authorizePanelMessage(OWNER_PERMISSIONS, { type: "start_server" }).ok).toBe(false);
    expect(authorizePanelMessage(OWNER_PERMISSIONS, { type: "restart_server", serverId: "" }).ok).toBe(false);
    expect(authorizePanelMessage(OWNER_PERMISSIONS, { type: "start_server", serverId: 5 }).ok).toBe(false);
  });
  it("reconstrói a mensagem — campos extras do cliente não passam", () => {
    const d = authorizePanelMessage(OWNER_PERMISSIONS, { type: "start_server", serverId: "abc", by: "falso", extra: 1 });
    expect(d).toEqual({ ok: true, forward: { type: "start_server", serverId: "abc" } });
  });
  it("nega tipos desconhecidos, mesmo para o dono", () => {
    expect(authorizePanelMessage(OWNER_PERMISSIONS, { type: "format_disk" }).ok).toBe(false);
    expect(authorizePanelMessage(OWNER_PERMISSIONS, { type: "log_line", line: "x" }).ok).toBe(false);
    expect(authorizePanelMessage(OWNER_PERMISSIONS, "texto").ok).toBe(false);
    expect(authorizePanelMessage(OWNER_PERMISSIONS, null).ok).toBe(false);
  });
});

describe("authorizePanelMessage — comandos", () => {
  const cmd = (p: PanelPermissions, command: unknown) => authorizePanelMessage(p, { type: "command", command });

  it("modo none nega tudo", () => {
    expect(cmd(perms(), "say oi").ok).toBe(false);
  });
  it("modo all libera qualquer comando (menos stop sem permissão de desligar)", () => {
    const p = perms({ commands: { mode: "all", allowlist: [] } });
    expect(cmd(p, "op fulano").ok).toBe(true);
    expect(cmd(p, "stop").ok).toBe(false);
    expect(cmd(p, "/STOP").ok).toBe(false);
    expect(cmd({ ...p, stop: true }, "stop").ok).toBe(true);
  });
  it("whitelist casa por prefixo de palavras, ignorando barra e caixa", () => {
    const p = perms({ commands: { mode: "allowlist", allowlist: ["say", "time set"] } });
    expect(cmd(p, "say olá mundo").ok).toBe(true);
    expect(cmd(p, "/Say olá").ok).toBe(true);
    expect(cmd(p, "time set day").ok).toBe(true);
    expect(cmd(p, "time add 5").ok).toBe(false);
    expect(cmd(p, "time").ok).toBe(false);
    expect(cmd(p, "op fulano").ok).toBe(false);
  });
  it("prefixo é por palavra inteira, não por texto ('say' não libera 'sayonara')", () => {
    const p = perms({ commands: { mode: "allowlist", allowlist: ["say"] } });
    expect(cmd(p, "sayonara").ok).toBe(false);
  });
  it("'stop' na whitelist continua exigindo a permissão de desligar", () => {
    const p = perms({ commands: { mode: "allowlist", allowlist: ["stop"] } });
    expect(cmd(p, "stop").ok).toBe(false);
    expect(cmd({ ...p, stop: true }, "stop").ok).toBe(true);
  });
  it("recusa quebra de linha (vários comandos numa mensagem só) e controle", () => {
    const p = perms({ commands: { mode: "allowlist", allowlist: ["say"] } });
    expect(cmd(p, "say oi\nstop").ok).toBe(false);
    expect(cmd(p, "say oi\rop eu").ok).toBe(false);
    expect(cmd(OWNER_PERMISSIONS, "say a\u0000b").ok).toBe(false);
  });
  it("recusa vazio, não-string e comando gigante", () => {
    expect(cmd(OWNER_PERMISSIONS, "   ").ok).toBe(false);
    expect(cmd(OWNER_PERMISSIONS, "/").ok).toBe(false);
    expect(cmd(OWNER_PERMISSIONS, 123).ok).toBe(false);
    expect(cmd(OWNER_PERMISSIONS, "say " + "a".repeat(600)).ok).toBe(false);
  });
});

describe("convites", () => {
  it("token é único, longo e seguro para URL", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(30);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("valida expiração e uso único", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(inviteUsable({ single_use: true, uses: 0, expires_at: future }, Date.now())).toBe(true);
    expect(inviteUsable({ single_use: true, uses: 1, expires_at: future }, Date.now())).toBe(false);
    expect(inviteUsable({ single_use: false, uses: 9, expires_at: future }, Date.now())).toBe(true);
    expect(inviteUsable({ single_use: false, uses: 0, expires_at: past }, Date.now())).toBe(false);
  });
});

describe("player_action (Modo Espectador Web)", () => {
  const mod = PERMISSION_PRESETS.moderator; // allowlist: say, kick, whitelist
  const act = (over: object = {}) => ({ type: "player_action", action: "kick", player: "Steve", requestId: "r-1", ...over });

  it("segue a política de comandos: kick liberado, ban não está na lista", () => {
    expect(authorizePanelMessage(mod, act())).toEqual({
      ok: true,
      forward: { type: "player_action", action: "kick", player: "Steve", requestId: "r-1" },
    });
    const ban = authorizePanelMessage(mod, act({ action: "ban" }));
    expect(ban.ok).toBe(false);
    if (!ban.ok) expect(ban.reason).toContain("ban");
  });
  it("sem permissão de comandos nada passa; com 'all' tudo passa", () => {
    expect(authorizePanelMessage(PERMISSION_PRESETS.viewer, act()).ok).toBe(false);
    expect(authorizePanelMessage(PERMISSION_PRESETS.operator, act()).ok).toBe(false);
    for (const action of ["kick", "ban", "pardon"]) {
      expect(authorizePanelMessage(OWNER_PERMISSIONS, act({ action })).ok).toBe(true);
    }
  });
  it("a allowlist casa sem diferenciar maiúsculas do nome", () => {
    const p = perms({ commands: { mode: "allowlist", allowlist: ["ban"] } });
    expect(authorizePanelMessage(p, act({ action: "ban", player: "STEVE" })).ok).toBe(true);
  });
  it("recusa ação desconhecida (incluindo as que parecem comando perigoso)", () => {
    for (const action of ["op", "deop", "stop", "kick ", "KICK", "", undefined, 5]) {
      expect(authorizePanelMessage(OWNER_PERMISSIONS, act({ action })).ok).toBe(false);
    }
  });
  it("recusa nome de jogador que poderia injetar comando", () => {
    for (const player of ["@a", "Steve stop", "Steve\nstop", "", "x".repeat(17), "ção", " Steve", undefined, 7, "."]) {
      expect(authorizePanelMessage(OWNER_PERMISSIONS, act({ player })).ok).toBe(false);
    }
    expect(authorizePanelMessage(OWNER_PERMISSIONS, act({ player: ".Bedrock" })).ok).toBe(true);
  });
  it("exige requestId simples (sem '.', que o relay usa como separador)", () => {
    for (const requestId of ["", "a.b", "a b", "x".repeat(41), undefined, 3]) {
      expect(authorizePanelMessage(OWNER_PERMISSIONS, act({ requestId })).ok).toBe(false);
    }
  });
  it("motivo: normaliza espaços, recusa controle e excesso; pardon ignora motivo", () => {
    const ok = authorizePanelMessage(OWNER_PERMISSIONS, act({ action: "ban", reason: "  fazendo   grief " }));
    expect(ok).toMatchObject({ ok: true, forward: { reason: "fazendo grief" } });
    expect(authorizePanelMessage(OWNER_PERMISSIONS, act({ action: "ban", reason: "   " }))).toEqual({
      ok: true,
      forward: { type: "player_action", action: "ban", player: "Steve", requestId: "r-1" },
    });
    expect(authorizePanelMessage(OWNER_PERMISSIONS, act({ action: "ban", reason: "x\nstop" })).ok).toBe(false);
    expect(authorizePanelMessage(OWNER_PERMISSIONS, act({ action: "ban", reason: "x".repeat(101) })).ok).toBe(false);
    expect(authorizePanelMessage(OWNER_PERMISSIONS, act({ action: "ban", reason: 42 })).ok).toBe(false);
    const pardon = authorizePanelMessage(OWNER_PERMISSIONS, act({ action: "pardon", reason: "x\nstop" }));
    expect(pardon).toMatchObject({ ok: true, forward: { action: "pardon" } });
    if (pardon.ok) expect("reason" in pardon.forward).toBe(false);
  });
  it("não repassa campos extras mandados pelo painel", () => {
    const d = authorizePanelMessage(OWNER_PERMISSIONS, act({ command: "stop", by: "Fingindo" }));
    expect(d).toEqual({ ok: true, forward: { type: "player_action", action: "kick", player: "Steve", requestId: "r-1" } });
  });
});

describe("players_refresh", () => {
  it("exige poder ver o console", () => {
    expect(authorizePanelMessage(perms({ viewConsole: false }), { type: "players_refresh" }).ok).toBe(false);
    expect(authorizePanelMessage(PERMISSION_PRESETS.viewer, { type: "players_refresh" })).toEqual({ ok: true, forward: { type: "players_refresh" } });
  });
});
