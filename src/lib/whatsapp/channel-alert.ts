// ============================================================
// Aviso de queda/volta de um canal de WhatsApp.
//
// O canal não-oficial cai sem barulho: o WhatsApp invalida o aparelho
// vinculado e o CRM passa a receber silêncio. Em outubro/2026 foram
// quatro dias até alguém perceber. Este aviso existe para o tempo entre
// "caiu" e "alguém leu o QR de novo" ser de minutos.
//
// Telegram porque é onde o operador já está; as duas variáveis são
// opcionais — sem elas o aviso não faz nada e o resto segue igual.
//   TELEGRAM_BOT_TOKEN   token do bot
//   TELEGRAM_CHAT_ID     chat ou grupo que recebe
// ============================================================

export async function notifyChannelEvent(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error('[channel-alert] telegram answered', res.status);
    }
  } catch (err) {
    // Aviso é melhor-esforço: não pode derrubar o processamento do webhook.
    console.error('[channel-alert] failed:', err);
  }
}
