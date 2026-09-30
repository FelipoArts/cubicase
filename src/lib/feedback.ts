import { getLocale } from "@/i18n";

// ============================================================
// Central de ajuda — envio de relatos (bug, problema, sugestão)
// ============================================================
// POST /api/v1/feedback na API Central, que repassa por e-mail para o
// mantenedor com Reply-To no e-mail informado aqui. As regras de tamanho
// espelham api/src/feedback.ts — a API é quem manda de verdade; a validação
// daqui só evita uma ida ao servidor por erro óbvio.
// ============================================================

const API_BASE = "https://cubeforge-api.cubeforge.workers.dev";

export const FEEDBACK_CATEGORIES = ["bug", "problem", "suggestion", "other"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_LIMITS = { subjectMin: 3, subjectMax: 120, messageMin: 10, messageMax: 4000, emailMax: 254 } as const;

export interface FeedbackDraft {
  category: FeedbackCategory | "";
  subject: string;
  message: string;
  email: string;
}

export type FeedbackField = "category" | "subject" | "message" | "email";

// Mesmo formato da API: sem espaços nem caracteres de cabeçalho, com "." no domínio.
const EMAIL_RE = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]{2,}$/;

export function isValidEmail(email: string): boolean {
  const v = email.trim();
  return v.length <= FEEDBACK_LIMITS.emailMax && EMAIL_RE.test(v);
}

/** Primeiro campo inválido, ou null se o rascunho pode ser enviado. */
export function validateFeedback(d: FeedbackDraft): FeedbackField | null {
  if (!d.category || !FEEDBACK_CATEGORIES.includes(d.category)) return "category";
  const subject = d.subject.trim().replace(/\s+/g, " ");
  if (subject.length < FEEDBACK_LIMITS.subjectMin || subject.length > FEEDBACK_LIMITS.subjectMax) return "subject";
  const message = d.message.trim();
  if (message.length < FEEDBACK_LIMITS.messageMin || message.length > FEEDBACK_LIMITS.messageMax) return "message";
  if (!isValidEmail(d.email)) return "email";
  return null;
}

export type FeedbackResult =
  | { ok: true }
  | { ok: false; reason: "validation"; field: FeedbackField | null }
  | { ok: false; reason: "rate" | "unavailable" | "network" | "server" };

export interface FeedbackEnv {
  appVersion?: string;
  os?: string;
}

export async function sendFeedback(d: FeedbackDraft, env: FeedbackEnv = {}, fetchImpl: typeof fetch = fetch): Promise<FeedbackResult> {
  const invalid = validateFeedback(d);
  if (invalid) return { ok: false, reason: "validation", field: invalid };

  let res: Response;
  try {
    res = await fetchImpl(`${API_BASE}/api/v1/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Language": getLocale() },
      body: JSON.stringify({
        category: d.category,
        subject: d.subject.trim(),
        message: d.message.trim(),
        email: d.email.trim(),
        appVersion: env.appVersion ?? "",
        os: env.os ?? "",
        locale: getLocale(),
        website: "", // honeypot: sempre vazio vindo do app
      }),
    });
  } catch {
    return { ok: false, reason: "network" };
  }

  if (res.ok) return { ok: true };
  if (res.status === 429) return { ok: false, reason: "rate" };
  if (res.status === 503) return { ok: false, reason: "unavailable" };
  if (res.status === 400) {
    const body = await res.json().catch(() => null);
    const field = body?.details?.field;
    return { ok: false, reason: "validation", field: FEEDBACK_FIELDS.includes(field) ? field : null };
  }
  return { ok: false, reason: "server" };
}

const FEEDBACK_FIELDS: readonly string[] = ["category", "subject", "message", "email"];

// ---- e-mail lembrado (só neste computador) ----
const EMAIL_KEY = "cubicase-help-email";

export function loadSavedEmail(): string {
  try {
    return localStorage.getItem(EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveEmail(email: string): void {
  try {
    localStorage.setItem(EMAIL_KEY, email.trim());
  } catch {
    /* storage indisponível: só não lembra */
  }
}

/** "Windows NT 10.0" etc. — sem dados pessoais, só a versão do sistema. */
export function describeOs(): string {
  if (typeof navigator === "undefined") return "";
  const m = /Windows NT [\d.]+/.exec(navigator.userAgent);
  return m ? m[0] : navigator.platform || "";
}
