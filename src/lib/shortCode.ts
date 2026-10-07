// Código curto de convite (CF-XXXXXX). Ele é a credencial de ENTRADA no servidor,
// então vem de um gerador criptográfico (crypto.getRandomValues), não de
// Math.random (previsível). Mesmo alfabeto do Worker (sem 0/O/1/I, que se confundem
// ao digitar): 32 símbolos, então `byte & 31` é uniforme (sem viés de módulo).

export const SHORT_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateShortCode(length = 6): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += SHORT_CODE_ALPHABET[b & 31];
  return out;
}
