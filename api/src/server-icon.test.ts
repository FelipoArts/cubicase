// ============================================================
// Ícone do servidor na central: só o dono envia, o PNG é validado, o status leva o hash e o convidado baixa a imagem
// ============================================================

import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { readPngSize } from "./index";

const BASE = "https://example.com";
let ipCounter = 0;
const ip = () => `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

async function createServer() {
  const res = await SELF.fetch(`${BASE}/api/v1/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip() },
    body: JSON.stringify({ name: "ComIcone", version: "1.20.1", serverType: "vanilla", description: "" }),
  });
  const body: any = await res.json();
  return { shortCode: body.data.shortCode as string, secret: body.data.ownerSecret as string };
}

/** PNG mínimo (só assinatura + IHDR + IDAT/IEND) com as dimensões pedidas — basta para a validação do Worker. */
function png(width: number, height: number, extra = 0): Uint8Array {
  const out: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  out.push(...u32(13), 0x49, 0x48, 0x44, 0x52, ...u32(width), ...u32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0);
  out.push(...u32(extra), 0x49, 0x44, 0x41, 0x54, ...new Array(extra).fill(7), 0, 0, 0, 0);
  out.push(...u32(0), 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82);
  return new Uint8Array(out);
}

const put = (code: string, secret: string | null, body: Uint8Array | string, extraHeaders: Record<string, string> = {}) =>
  SELF.fetch(`${BASE}/api/v1/servers/${code}/icon`, {
    method: "PUT",
    headers: { "Content-Type": "image/png", "CF-Connecting-IP": ip(), ...(secret ? { "X-Owner-Secret": secret } : {}), ...extraHeaders },
    body: body as BodyInit,
  });
const discover = async (code: string) => ((await (await SELF.fetch(`${BASE}/api/v1/servers/${code}`)).json()) as any).data.server;

describe("readPngSize", () => {
  it("lê as dimensões de um PNG e recusa o que não é PNG", () => {
    expect(readPngSize(png(64, 64))).toEqual({ width: 64, height: 64 });
    expect(readPngSize(png(128, 32))).toEqual({ width: 128, height: 32 });
    expect(readPngSize(new Uint8Array(40))).toBeNull();
    expect(readPngSize(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"))).toBeNull();
    expect(readPngSize(png(64, 64).slice(0, 20))).toBeNull(); // truncado
    const bad = png(64, 64); bad[12] = 0x58; // bloco que não é IHDR
    expect(readPngSize(bad)).toBeNull();
  });
});

describe("ícone do servidor", () => {
  it("o dono envia, o status ganha o hash e qualquer pessoa baixa a imagem", async () => {
    const { shortCode, secret } = await createServer();
    expect((await discover(shortCode)).iconHash ?? null).toBeNull();
    expect((await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/icon`)).status).toBe(404);

    const image = png(64, 64, 200);
    const res = await put(shortCode, secret, image);
    expect(res.status).toBe(200);
    const { iconHash } = ((await res.json()) as any).data;
    expect(iconHash).toMatch(/^[a-f0-9]{16}$/);
    expect((await discover(shortCode)).iconHash).toBe(iconHash);

    const get = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/icon?v=${iconHash}`);
    expect(get.status).toBe(200);
    expect(get.headers.get("Content-Type")).toBe("image/png");
    expect(get.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(get.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(get.headers.get("Cache-Control")).toContain("immutable");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(image);
    // Sem a versão na URL o cache é curto (a imagem pode ter mudado).
    expect((await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/icon`)).headers.get("Cache-Control")).toContain("max-age=300");
  });

  it("enviar a mesma imagem de novo não muda nada; imagem diferente troca o hash", async () => {
    const { shortCode, secret } = await createServer();
    const a = ((await (await put(shortCode, secret, png(64, 64, 10))).json()) as any).data.iconHash;
    const again = await put(shortCode, secret, png(64, 64, 10));
    expect(((await again.json()) as any).data.iconHash).toBe(a);
    const b = ((await (await put(shortCode, secret, png(64, 64, 11))).json()) as any).data.iconHash;
    expect(b).not.toBe(a);
    expect((await discover(shortCode)).iconHash).toBe(b);
  });

  it("sem o segredo do dono, ou com o segredo errado, ninguém envia nem remove", async () => {
    const { shortCode, secret } = await createServer();
    const other = await createServer();
    expect((await put(shortCode, null, png(64, 64))).status).toBe(401);
    expect((await put(shortCode, other.secret, png(64, 64))).status).toBe(403);
    await put(shortCode, secret, png(64, 64));
    const del = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/icon`, { method: "DELETE", headers: { "X-Owner-Secret": other.secret } });
    expect(del.status).toBe(403);
    expect((await discover(shortCode)).iconHash).toBeTruthy();
  });

  it("recusa o que não é um PNG quadrado de até 128 px e de até 32 KB", async () => {
    const { shortCode, secret } = await createServer();
    expect((await put(shortCode, secret, "isto não é uma imagem, é só um texto comprido o bastante para passar do mínimo")).status).toBe(400);
    expect((await put(shortCode, secret, new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"))).status).toBe(400);
    expect((await put(shortCode, secret, png(64, 32))).status).toBe(400);     // não quadrado
    expect((await put(shortCode, secret, png(256, 256))).status).toBe(400);   // grande demais em pixels
    expect((await put(shortCode, secret, png(0, 0))).status).toBe(400);
    expect((await put(shortCode, secret, png(64, 64, 40_000))).status).toBe(413); // pesado demais
    expect((await put(shortCode, secret, new Uint8Array(0))).status).toBe(413);
    expect((await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/icon`)).status).toBe(404); // nada foi gravado
  });

  it("remover o ícone apaga a imagem e o hash", async () => {
    const { shortCode, secret } = await createServer();
    await put(shortCode, secret, png(64, 64));
    const del = await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/icon`, { method: "DELETE", headers: { "X-Owner-Secret": secret } });
    expect(del.status).toBe(200);
    expect((await discover(shortCode)).iconHash ?? null).toBeNull();
    expect((await SELF.fetch(`${BASE}/api/v1/servers/${shortCode}/icon`)).status).toBe(404);
  });

  it("apagar o servidor leva o ícone junto; trocar o código leva a imagem para o código novo", async () => {
    const a = await createServer();
    await put(a.shortCode, a.secret, png(64, 64));
    await SELF.fetch(`${BASE}/api/v1/servers/${a.shortCode}`, { method: "DELETE", headers: { "X-Owner-Secret": a.secret } });
    expect((await SELF.fetch(`${BASE}/api/v1/servers/${a.shortCode}/icon`)).status).toBe(404);

    const b = await createServer();
    const image = png(64, 64, 33);
    await put(b.shortCode, b.secret, image);
    const regen = await SELF.fetch(`${BASE}/api/v1/servers/${b.shortCode}/regenerate-code`, { method: "POST", headers: { "X-Owner-Secret": b.secret, "CF-Connecting-IP": ip() } });
    expect(regen.status).toBe(200);
    const newCode = ((await regen.json()) as any).data.shortCode as string;
    expect((await SELF.fetch(`${BASE}/api/v1/servers/${b.shortCode}/icon`)).status).toBe(404);
    const moved = await SELF.fetch(`${BASE}/api/v1/servers/${newCode}/icon`);
    expect(moved.status).toBe(200);
    expect(new Uint8Array(await moved.arrayBuffer())).toEqual(image);
  });
});
