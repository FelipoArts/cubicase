// ============================================================
// Quando o Convidado precisa consultar o status de um servidor
// ============================================================
// A biblioteca consulta a API Central a cada 30 s para cada servidor conhecido. Duas economias, sem perder nada que a
// pessoa veria:
//   1. Ninguém olhando (janela escondida/minimizada), não consulta — e ao voltar, atualiza na hora.
//   2. Servidor parado há muito tempo muda raramente: consulta a cada 2 min em vez de 30 s. Assim que ele aparecer
//      ligado (ou a pessoa pedir "atualizar"), volta ao ritmo normal.
// ============================================================

export const POLL_INTERVAL_MS = 30_000;
/** Servidor parado há mais que isso passa a ser consultado com menos frequência. */
export const IDLE_AFTER_MS = 30 * 60_000;
export const IDLE_POLL_INTERVAL_MS = 120_000;
/** Ao voltar para a janela, só atualiza na hora se a última consulta for mais velha que isto. */
export const REFRESH_ON_RETURN_MS = 10_000;

interface PollTarget {
  status: string;
  minecraftStatus: string | null;
  lastSeenOnline: string | null;
}

/** Parado e sem sinal de vida há bastante tempo (ou nunca visto ligado). */
export function isIdleServer(s: PollTarget, now: number): boolean {
  const down = s.status !== "online" && s.status !== "starting" && s.minecraftStatus !== "online" && s.minecraftStatus !== "starting" && s.minecraftStatus !== "sleeping";
  if (!down) return false;
  if (!s.lastSeenOnline) return true;
  const seen = Date.parse(s.lastSeenOnline);
  return !Number.isFinite(seen) || now - seen > IDLE_AFTER_MS;
}

/** Vale consultar este servidor agora? `force` = a pessoa pediu "atualizar" (ou é a primeira consulta). */
export function shouldPoll(s: PollTarget, lastCheckedAt: number | undefined, now: number, force: boolean): boolean {
  if (force || lastCheckedAt === undefined) return true;
  if (!isIdleServer(s, now)) return true;
  return now - lastCheckedAt >= IDLE_POLL_INTERVAL_MS - 1000; // folga: o relógio de 30 s nunca cai exatamente em 120 s
}
