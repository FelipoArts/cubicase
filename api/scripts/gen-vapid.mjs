// Gera o par de chaves VAPID das notificações push do painel web.
//   node api/scripts/gen-vapid.mjs
// Depois (na pasta api/):
//   wrangler secret put VAPID_PUBLIC_KEY
//   wrangler secret put VAPID_PRIVATE_KEY
//   wrangler secret put VAPID_SUBJECT      (ex.: mailto:contato@cubicase.net)
// Guarde a chave privada como qualquer segredo: quem a tem pode enviar notificações em nome do Cubicase.
import { webcrypto as crypto } from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);

console.log("VAPID_PUBLIC_KEY=" + b64url(pub));
console.log("VAPID_PRIVATE_KEY=" + jwk.d);
