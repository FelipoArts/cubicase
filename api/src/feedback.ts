// ============================================================
// Central de ajuda — relatos de bug / problema / sugestão
// ============================================================
// O app (e, no futuro, o site) manda POST /api/v1/feedback. Este módulo só
// tem a parte pura (validação, montagem do e-mail, envio via Resend); o
// roteamento, rate limit e o formato de resposta ficam em index.ts, junto
// dos demais handlers.
//
// O e-mail chega para FEEDBACK_TO_EMAIL com o Reply-To apontando para o
// e-mail informado pela pessoa — responder direto do seu cliente de e-mail
// já responde a ela. Nada é gravado em KV/banco além de um hash curto para
// barrar reenvios idênticos.
// ============================================================

export const FEEDBACK_CATEGORIES = ['bug', 'problem', 'suggestion', 'other'] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_LIMITS = {
  subjectMin: 3,
  subjectMax: 120,
  messageMin: 10,
  messageMax: 4000,
  emailMax: 254,
  metaMax: 80,
  bodyMaxBytes: 16_000,
} as const;

export interface FeedbackInput {
  category: FeedbackCategory;
  subject: string;
  message: string;
  email: string;
  appVersion: string;
  os: string;
  locale: string;
  /** Honeypot: campo escondido no formulário que humanos nunca preenchem. */
  honeypot: boolean;
}

export type FeedbackField = 'category' | 'subject' | 'message' | 'email';

const EMAIL_RE = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]{2,}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function cleanText(v: unknown): string {
  return typeof v === 'string' ? v.replace(CONTROL_CHARS, '').replace(/\r\n/g, '\n').trim() : '';
}

/** Uma linha só (assunto, metadados): sem quebras de linha. */
function cleanLine(v: unknown, max: number): string {
  return cleanText(v).replace(/\s+/g, ' ').slice(0, max);
}

export function parseFeedback(raw: unknown): { ok: true; value: FeedbackInput } | { ok: false; field: FeedbackField } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const category = cleanLine(r.category, 20) as FeedbackCategory;
  if (!FEEDBACK_CATEGORIES.includes(category)) return { ok: false, field: 'category' };

  const subject = cleanLine(r.subject, FEEDBACK_LIMITS.subjectMax + 1);
  if (subject.length < FEEDBACK_LIMITS.subjectMin || subject.length > FEEDBACK_LIMITS.subjectMax) return { ok: false, field: 'subject' };

  const message = cleanText(r.message);
  if (message.length < FEEDBACK_LIMITS.messageMin || message.length > FEEDBACK_LIMITS.messageMax) return { ok: false, field: 'message' };

  const email = cleanLine(r.email, FEEDBACK_LIMITS.emailMax + 1);
  if (email.length > FEEDBACK_LIMITS.emailMax || !EMAIL_RE.test(email)) return { ok: false, field: 'email' };

  return {
    ok: true,
    value: {
      category,
      subject,
      message,
      email,
      appVersion: cleanLine(r.appVersion, FEEDBACK_LIMITS.metaMax),
      os: cleanLine(r.os, FEEDBACK_LIMITS.metaMax),
      locale: cleanLine(r.locale, 20),
      honeypot: cleanText(r.website).length > 0,
    },
  };
}

const CATEGORY_LABEL: Record<FeedbackCategory, string> = {
  bug: 'Bug',
  problem: 'Problema',
  suggestion: 'Sugestão',
  other: 'Outro',
};

export function buildFeedbackEmail(f: FeedbackInput): { subject: string; text: string } {
  const meta = [
    f.appVersion && `Versão do app: ${f.appVersion}`,
    f.os && `Sistema: ${f.os}`,
    f.locale && `Idioma: ${f.locale}`,
  ].filter(Boolean);
  return {
    subject: `[Cubicase] [${CATEGORY_LABEL[f.category]}] ${f.subject}`,
    text: [
      `Tipo: ${CATEGORY_LABEL[f.category]}`,
      `E-mail para resposta: ${f.email}`,
      ...meta,
      '',
      f.message,
      '',
      '—',
      'Enviado pela Central de Ajuda do Cubicase. Responder este e-mail responde à pessoa.',
    ].join('\n'),
  };
}

export interface FeedbackMailEnv {
  RESEND_API_KEY?: string;
  FEEDBACK_TO_EMAIL?: string;
  FEEDBACK_FROM_EMAIL?: string;
}

/** Hash curto (conteúdo idêntico = mesmo relato) para barrar reenvios/duplo clique entre dispositivos. */
export async function feedbackFingerprint(f: FeedbackInput): Promise<string> {
  const data = new TextEncoder().encode([f.email.toLowerCase(), f.category, f.subject, f.message].join('\u0001'));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function feedbackMailConfigured(env: FeedbackMailEnv): boolean {
  return !!(env.RESEND_API_KEY && env.FEEDBACK_TO_EMAIL);
}

/** Envia via Resend (https://resend.com/docs/api-reference/emails/send-email). true = aceito pelo provedor. */
export async function sendFeedbackEmail(env: FeedbackMailEnv, f: FeedbackInput, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const mail = buildFeedbackEmail(f);
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.FEEDBACK_FROM_EMAIL || 'Cubicase <onboarding@resend.dev>',
        to: [env.FEEDBACK_TO_EMAIL],
        reply_to: f.email,
        subject: mail.subject,
        text: mail.text,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
