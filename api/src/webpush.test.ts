// ============================================================
// Testes do Web Push (webpush.ts): cifra aes128gcm (RFC 8291), cabeçalho VAPID e lista de destinos
// ============================================================
// A decifragem abaixo é a do lado do navegador (RFC 8291 §3.4). Ela foi conferida contra a saída do pacote
// `web-push` (Node) — se os dois lados concordam com uma implementação independente, a cifra é interoperável.
// ============================================================

import { describe, it, expect } from "vitest";
import { b64urlDecode, b64urlEncode, encryptPayload, isAllowedPushEndpoint, vapidAuthorization, sendWebPush } from "./webpush";

const enc = new TextEncoder();
const dec = new TextDecoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** Navegador recebendo: usa a chave privada da inscrição (`uaPrivate`) para abrir o corpo. */
async function decryptAsBrowser(body: Uint8Array, uaPrivate: CryptoKey, uaPublic: Uint8Array, authSecret: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const serverPublic = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const serverKey = await crypto.subtle.importKey("raw", serverPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: serverKey }, uaPrivate, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode("WebPush: info\0"), uaPublic, serverPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, cipher));
  expect(plain[plain.length - 1]).toBe(2); // delimitador do último registro
  return dec.decode(plain.slice(0, -1));
}

async function browserKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pair, pub, auth: crypto.getRandomValues(new Uint8Array(16)) };
}

describe("encryptPayload", () => {
  it("o navegador consegue abrir o que o Worker cifrou (inclusive acentos)", async () => {
    const b = await browserKeys();
    const message = JSON.stringify({ title: "Servidor parou", body: "Ação concluída — João saiu" });
    const body = await encryptPayload(enc.encode(message), b.pub, b.auth);
    expect(await decryptAsBrowser(body, b.pair.privateKey, b.pub, b.auth)).toBe(message);
  });

  it("cabeçalho do corpo: sal de 16 bytes, registro de 4096 e chave efêmera de 65 bytes", async () => {
    const b = await browserKeys();
    const body = await encryptPayload(enc.encode("oi"), b.pub, b.auth);
    expect(new DataView(body.buffer, body.byteOffset).getUint32(16)).toBe(4096);
    expect(body[20]).toBe(65);
    expect(body[21]).toBe(4); // ponto não comprimido
    // 21 + 65 de cabeçalho + (2 de dados + 1 de delimitador + 16 da etiqueta GCM)
    expect(body.length).toBe(86 + 3 + 16);
  });

  it("cada envio usa sal e chave efêmera novos", async () => {
    const b = await browserKeys();
    const a = await encryptPayload(enc.encode("x"), b.pub, b.auth);
    const c = await encryptPayload(enc.encode("x"), b.pub, b.auth);
    expect(b64urlEncode(a.slice(0, 16))).not.toBe(b64urlEncode(c.slice(0, 16)));
    expect(b64urlEncode(a.slice(21, 86))).not.toBe(b64urlEncode(c.slice(21, 86)));
  });

  it("recusa chave ou segredo malformados e mensagem que não cabe no registro", async () => {
    const b = await browserKeys();
    await expect(encryptPayload(enc.encode("x"), b.pub.slice(0, 64), b.auth)).rejects.toThrow();
    await expect(encryptPayload(enc.encode("x"), b.pub, b.auth.slice(0, 15))).rejects.toThrow();
    await expect(encryptPayload(new Uint8Array(4100), b.pub, b.auth)).rejects.toThrow();
  });

  it("outra inscrição não consegue abrir a mensagem", async () => {
    const b = await browserKeys();
    const other = await browserKeys();
    const body = await encryptPayload(enc.encode("segredo"), b.pub, b.auth);
    await expect(decryptAsBrowser(body, other.pair.privateKey, other.pub, other.auth)).rejects.toThrow();
  });
});

describe("vapidAuthorization", () => {
  it("JWT ES256 com audiência do serviço de push, validade de 12h e assinatura verificável", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const keys = { publicKey: b64urlEncode(pub), privateKey: jwk.d!, subject: "mailto:teste@cubicase.net" };

    const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, 1_000_000);
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header)!;
    expect(m).toBeTruthy();
    expect(m[4]).toBe(keys.publicKey);
    const claims = JSON.parse(dec.decode(b64urlDecode(m[2])));
    expect(claims).toEqual({ aud: "https://fcm.googleapis.com", exp: 1_000_000 + 12 * 3600, sub: "mailto:teste@cubicase.net" });
    expect(JSON.parse(dec.decode(b64urlDecode(m[1])))).toEqual({ typ: "JWT", alg: "ES256" });
    const sig = b64urlDecode(m[3]);
    expect(sig.length).toBe(64); // r||s, como o JWT exige
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, sig, enc.encode(`${m[1]}.${m[2]}`));
    expect(ok).toBe(true);
  });
});

describe("isAllowedPushEndpoint", () => {
  it("aceita só os serviços de push conhecidos, em https, sem credenciais nem porta", () => {
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://wns2-par02p.notify.windows.com/?token=abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://web.push.apple.com/abc")).toBe(true);

    expect(isAllowedPushEndpoint("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(isAllowedPushEndpoint("https://evil.example.com/fcm.googleapis.com")).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com.evil.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://notfcm.googleapis.com.br/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://user:pw@fcm.googleapis.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com:8443/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://169.254.169.254/latest")).toBe(false);
    expect(isAllowedPushEndpoint("not a url")).toBe(false);
    expect(isAllowedPushEndpoint(42)).toBe(false);
  });

  it("não faz requisição para destino fora da lista", async () => {
    const keys = { publicKey: "x", privateKey: "y", subject: "mailto:a@b.c" };
    const outcome = await sendWebPush({ endpoint: "https://evil.example.com/x", p256dh: "a", auth: "b" }, {}, keys);
    expect(outcome).toBe("gone");
  });
});
