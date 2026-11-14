// ============================================================
// Testes da gravação da sequência do Plus (Supabase simulado)
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { getStreaks, recordActive, recordEnded } from "./plus-streak";

const USER = "123e4567-e89b-42d3-a456-426614174000";
const env = { SUPABASE_SERVICE_ROLE_KEY: "service-key" };
const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 0, 1);

type Row = { user_id: string; streak_started: string; counted_ms: number; segment_start: string; last_active_end: string };

/** Tabela plus_streaks em memória atrás do fetch. */
function fakeTable(initial: Row | null = null) {
  let row = initial;
  const writes: Row[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("/rest/v1/plus_streaks")) return new Response("[]", { status: 404 });
    if (init?.method === "POST") {
      row = (JSON.parse(String(init.body)) as Row[])[0];
      writes.push(row);
      return new Response(null, { status: 201 });
    }
    return Response.json(row ? [row] : []);
  }));
  return { writes, get row() { return row; } };
}

afterEach(() => vi.unstubAllGlobals());

describe("recordActive", () => {
  it("primeira assinatura cria a sequência", async () => {
    const t = fakeTable();
    await recordActive(env, USER, T0 + 30 * DAY, T0);
    expect(t.writes).toHaveLength(1);
    expect(t.row).toMatchObject({ user_id: USER, counted_ms: 0 });
    expect(Date.parse(t.row!.last_active_end)).toBe(T0 + 30 * DAY);
  });

  it("renovação a tempo estende sem reiniciar", async () => {
    const t = fakeTable();
    await recordActive(env, USER, T0 + 30 * DAY, T0);
    await recordActive(env, USER, T0 + 60 * DAY, T0 + 30 * DAY - 1000);
    expect(Date.parse(t.row!.segment_start)).toBe(T0);
    expect(Date.parse(t.row!.last_active_end)).toBe(T0 + 60 * DAY);
  });

  it("volta depois de mais de 7 dias: zera", async () => {
    const t = fakeTable();
    await recordActive(env, USER, T0 + 30 * DAY, T0);
    const back = T0 + 30 * DAY + 8 * DAY;
    await recordActive(env, USER, back + 30 * DAY, back);
    expect(t.row!.counted_ms).toBe(0);
    expect(Date.parse(t.row!.segment_start)).toBe(back);
  });

  it("evento antigo reenviado não grava nada", async () => {
    const t = fakeTable();
    await recordActive(env, USER, T0 + 30 * DAY, T0);
    t.writes.length = 0;
    await recordActive(env, USER, T0 + 30 * DAY, T0 + 40 * DAY); // período já passou
    expect(t.writes).toHaveLength(0);
  });

  it("não quebra sem a chave de serviço, com id inválido ou com o Supabase fora do ar", async () => {
    fakeTable();
    await expect(recordActive({}, USER, T0 + DAY, T0)).resolves.toBeUndefined();
    await expect(recordActive(env, "nao-e-uuid", T0 + DAY, T0)).resolves.toBeUndefined();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("rede"); }));
    await expect(recordActive(env, USER, T0 + DAY, T0)).resolves.toBeUndefined();
  });
});

describe("recordEnded", () => {
  it("encerrar a assinatura corta o que sobrava do período pago", async () => {
    const t = fakeTable();
    await recordActive(env, USER, T0 + 30 * DAY, T0);
    await recordEnded(env, USER, T0 + 10 * DAY);
    expect(Date.parse(t.row!.last_active_end)).toBe(T0 + 10 * DAY);
  });

  it("sem sequência, não cria nada", async () => {
    const t = fakeTable();
    await recordEnded(env, USER, T0);
    expect(t.writes).toHaveLength(0);
  });
});

describe("getStreaks", () => {
  it("ignora linhas inválidas e ids que não são UUID", async () => {
    fakeTable({ user_id: USER, streak_started: "lixo", counted_ms: 0, segment_start: "lixo", last_active_end: "lixo" });
    expect((await getStreaks(env, [USER])).size).toBe(0);
    expect((await getStreaks(env, ["x),y=eq.("])).size).toBe(0);
  });
});
