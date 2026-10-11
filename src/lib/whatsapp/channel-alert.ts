// ============================================================
// Aviso de queda/volta de um canal de WhatsApp.
//
// O canal não-oficial cai sem barulho: o WhatsApp invalida o aparelho
// vinculado e o CRM passa a receber silêncio. Em outubro/2026 foram
// quatro dias até alguém perceber. Este aviso existe para o tempo entre
// "caiu" e "alguém leu o QR de novo" ser de minutos.
//
// Dois destinos, ambos opcionais e independentes — sem as variáveis o
// destino não faz nada e o resto segue igual:
//
//   Telegram  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   E-mail    MAILER_URL, MAILER_KEY, ALERT_EMAIL_TO (lista por vírgula),
//             ALERT_EMAIL_FROM (opcional; precisa estar liberado na chave)
// ============================================================

const TIMEOUT_MS = 10_000;

async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) console.error('[channel-alert] telegram answered', res.status);
    return res.ok;
  } catch (err) {
    console.error('[channel-alert] telegram failed:', err);
    return false;
  }
}

async function sendEmail(
  subject: string,
  text: string,
  idempotencyKey?: string
): Promise<boolean> {
  const url = process.env.MAILER_URL;
  const key = process.env.MAILER_KEY;
  const to = (process.env.ALERT_EMAIL_TO ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!url || !key || to.length === 0) return false;
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/v1/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        to,
        subject,
        text,
        ...(process.env.ALERT_EMAIL_FROM
          ? { from: process.env.ALERT_EMAIL_FROM }
          : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 202 = na fila para nova tentativa; também conta como aceito.
    if (!res.ok) console.error('[channel-alert] mailer answered', res.status);
    return res.ok;
  } catch (err) {
    console.error('[channel-alert] email failed:', err);
    return false;
  }
}

/**
 * Manda o aviso por todos os destinos configurados. Melhor-esforço: um
 * destino fora do ar não pode derrubar o processamento do webhook nem o
 * do vigia, e um não impede o outro.
 */
export async function notifyChannelEvent(
  subject: string,
  text: string,
  idempotencyKey?: string
): Promise<{ telegram: boolean; email: boolean }> {
  const [telegram, email] = await Promise.all([
    sendTelegram(`${subject}\n\n${text}`),
    sendEmail(subject, text, idempotencyKey),
  ]);
  return { telegram, email };
}
