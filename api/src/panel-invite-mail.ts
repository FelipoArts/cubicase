// ============================================================
// E-mail do convite de acesso ao painel (convite por e-mail)
// ============================================================
// Só sai se houver um remetente PRÓPRIO configurado (INVITE_FROM_EMAIL, num domínio verificado no Resend): o remetente de
// teste do Resend (onboarding@resend.dev) só entrega para o dono da conta do Resend, então tentar com ele só falharia.
// O e-mail só vai para uma conta que JÁ existe (o convite checa isso antes) e é um por convite (reconvidar substitui o
// anterior), então não serve para mandar spam para endereços aleatórios.
//
// Falha de envio nunca derruba o convite: ele já está criado e a pessoa o vê ao abrir o painel; o host é avisado de que o
// e-mail não saiu para poder avisar por outro meio.
// ============================================================

export interface InviteMailEnv {
  RESEND_API_KEY?: string;
  /** Ex.: "Cubicase <convites@cubicase.net>" — precisa ser de um domínio verificado no Resend. */
  INVITE_FROM_EMAIL?: string;
}

export interface InviteMailParams {
  to: string;
  /** Nome (ou e-mail) de quem convidou. */
  owner: string;
  /** Nome do computador. */
  device: string;
  /** Validade, em dias. */
  days: number;
}

export const PANEL_URL = 'https://cubicase.net/painel/';

export function inviteMailConfigured(env: InviteMailEnv): boolean {
  return !!(env.RESEND_API_KEY && env.INVITE_FROM_EMAIL);
}

/** Tira quebras de linha e caracteres de controle (nada que venha de fora vira cabeçalho ou texto fora do lugar). */
function clean(s: string, max = 80): string {
  return s.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function buildInviteEmail(p: InviteMailParams): { subject: string; text: string } {
  const owner = clean(p.owner), device = clean(p.device), to = clean(p.to, 254);
  return {
    subject: `${owner} convidou você para o painel do Cubicase / invited you to the Cubicase panel`,
    text:
`Olá!

${owner} convidou você para acessar o computador "${device}" no painel web do Cubicase.

Para aceitar:
1. Abra ${PANEL_URL}
2. Entre com este e-mail (${to}).
3. O convite aparece em "Convites para você". Ele vale por ${p.days} dias.

Você não precisa ter o Cubicase Plus para aceitar. Se você não conhece essa pessoa, é só ignorar este e-mail.

Este é um e-mail automático: não precisa responder.

------------------------------

Hi!

${owner} invited you to access the computer "${device}" on the Cubicase web panel.

To accept:
1. Open ${PANEL_URL}
2. Sign in with this email (${to}).
3. The invite shows up under "Invites for you". It is valid for ${p.days} days.

You do not need Cubicase Plus to accept. If you do not know this person, just ignore this email.

This is an automatic email: there is no need to reply.
`,
  };
}

/** true se o Resend aceitou o envio. Sem remetente configurado, nem tenta. */
export async function sendInviteEmail(env: InviteMailEnv, p: InviteMailParams, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!inviteMailConfigured(env)) return false;
  const mail = buildInviteEmail(p);
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.INVITE_FROM_EMAIL, to: [p.to], subject: mail.subject, text: mail.text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
