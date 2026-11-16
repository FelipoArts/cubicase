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
    for (const action of ["stop", "whitelist", "op ", "OP", "deop_all", "kick ", "KICK", "", undefined, 5]) {
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

describe("listas de acesso (whitelist, operadores, banidos)", () => {
  const mod = PERMISSION_PRESETS.moderator; // allowlist: say, kick, whitelist
  const act = (action: string, over: object = {}) => ({ type: "player_action", action, player: "Steve", requestId: "r-1", ...over });

  it("whitelist segue o comando 'whitelist': o moderador pode, quem só roda 'say' não", () => {
    for (const action of ["whitelist_add", "whitelist_remove"]) {
      expect(authorizePanelMessage(mod, act(action))).toEqual({ ok: true, forward: { type: "player_action", action, player: "Steve", requestId: "r-1" } });
    }
    const onlySay = perms({ commands: { mode: "allowlist", allowlist: ["say"] } });
    expect(authorizePanelMessage(onlySay, act("whitelist_add")).ok).toBe(false);
  });

  it("op e deop só passam para quem pode rodar esse comando (o moderador não pode; o dono pode)", () => {
    for (const action of ["op", "deop"]) {
      const denied = authorizePanelMessage(mod, act(action));
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.reason).toContain(action);
      expect(authorizePanelMessage(OWNER_PERMISSIONS, act(action)).ok).toBe(true);
      expect(authorizePanelMessage(perms({ commands: { mode: "allowlist", allowlist: [action] } }), act(action)).ok).toBe(true);
      expect(authorizePanelMessage(PERMISSION_PRESETS.viewer, act(action)).ok).toBe(false);
      expect(authorizePanelMessage(PERMISSION_PRESETS.operator, act(action)).ok).toBe(false);
    }
  });

  it("uma allowlist 'whitelist add' libera adicionar mas não remover", () => {
    const p = perms({ commands: { mode: "allowlist", allowlist: ["whitelist add"] } });
    expect(authorizePanelMessage(p, act("whitelist_add")).ok).toBe(true);
    expect(authorizePanelMessage(p, act("whitelist_remove")).ok).toBe(false);
  });

  it("nome de jogador inválido continua barrado e o motivo só vale para kick e ban", () => {
    expect(authorizePanelMessage(OWNER_PERMISSIONS, act("whitelist_add", { player: "Steve\nstop" })).ok).toBe(false);
    expect(authorizePanelMessage(OWNER_PERMISSIONS, act("op", { player: "@a" })).ok).toBe(false);
    const d = authorizePanelMessage(OWNER_PERMISSIONS, act("op", { reason: "x\nstop" }));
    expect(d).toMatchObject({ ok: true });
    if (d.ok) expect("reason" in d.forward).toBe(false);
  });
});

describe("comandos que furam a lista (execute, function, schedule, return)", () => {
  const cmd = (command: string) => ({ type: "command", command });
  const listed = (...entries: string[]) => perms({ commands: { mode: "allowlist", allowlist: entries } });

  it("mesmo com o comando na lista, numa lista de comandos eles são negados com um motivo claro", () => {
    for (const c of ["execute run op Steve", "EXECUTE as @a run say oi", "function meu:pack", "schedule function a:b 1t", "return run say oi", "minecraft:execute run stop"]) {
      const d = authorizePanelMessage(listed("execute", "function", "schedule", "return", "minecraft:execute", "say"), cmd(c));
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.reason).toContain("Todos os comandos");
    }
  });

  it("com 'Todos os comandos' continuam passando, e os comandos comuns da lista seguem funcionando", () => {
    expect(authorizePanelMessage(OWNER_PERMISSIONS, cmd("execute run say oi")).ok).toBe(true);
    expect(authorizePanelMessage(listed("say"), cmd("say oi")).ok).toBe(true);
    expect(authorizePanelMessage(listed("say"), cmd("executeish")).ok).toBe(false);
  });

  it("uma ação de jogador também passa pela mesma regra (a lista só tem comandos comuns)", () => {
    const d = authorizePanelMessage(listed("whitelist"), { type: "player_action", action: "whitelist_add", player: "Steve", requestId: "r1" });
    expect(d.ok).toBe(true);
  });
});

describe("access_lists_get", () => {
  it("exige poder ver o console e um id de servidor válido", () => {
    expect(authorizePanelMessage(PERMISSION_PRESETS.viewer, { type: "access_lists_get", serverId: "s1" })).toEqual({ ok: true, forward: { type: "access_lists_get", serverId: "s1" } });
    expect(authorizePanelMessage(perms({ viewConsole: false }), { type: "access_lists_get", serverId: "s1" }).ok).toBe(false);
    for (const serverId of ["", undefined, 5, "a\nb", "x".repeat(201)]) {
      expect(authorizePanelMessage(OWNER_PERMISSIONS, { type: "access_lists_get", serverId }).ok).toBe(false);
    }
  });
  it("não repassa campos extras", () => {
    expect(authorizePanelMessage(OWNER_PERMISSIONS, { type: "access_lists_get", serverId: "s1", path: "C:/x" })).toEqual({ ok: true, forward: { type: "access_lists_get", serverId: "s1" } });
  });
});

describe("players_refresh", () => {
  it("exige poder ver o console", () => {
    expect(authorizePanelMessage(perms({ viewConsole: false }), { type: "players_refresh" }).ok).toBe(false);
    expect(authorizePanelMessage(PERMISSION_PRESETS.viewer, { type: "players_refresh" })).toEqual({ ok: true, forward: { type: "players_refresh" } });
  });
});

describe("backup pelo painel", () => {
  it("exige poder ligar e desligar e um id de servidor válido", () => {
    expect(authorizePanelMessage(OWNER_PERMISSIONS, { type: "backup", serverId: "s1" })).toEqual({ ok: true, forward: { type: "backup", serverId: "s1" } });
    expect(authorizePanelMessage(PERMISSION_PRESETS.viewer, { type: "backup", serverId: "s1" })).toMatchObject({ ok: false });
    expect(authorizePanelMessage({ ...PERMISSION_PRESETS.operator, stop: false }, { type: "backup", serverId: "s1" })).toMatchObject({ ok: false });
    expect(authorizePanelMessage(OWNER_PERMISSIONS, { type: "backup" })).toMatchObject({ ok: false });
    expect(authorizePanelMessage(OWNER_PERMISSIONS, { type: "backup", serverId: "a\nb" })).toMatchObject({ ok: false });
  });
});
