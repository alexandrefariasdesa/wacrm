// ============================================================
// /api/whatsapp/channels/unofficial
//
//   GET    — estado do canal não-oficial (e o QR, quando pareando).
//   POST   — cadastra/atualiza o canal e prepara a instância no provedor.
//   DELETE — desconecta e remove o canal.
//
// Este é o cadastro que a API oficial não tem equivalente: em vez de
// credenciais que a Meta te dá, aqui você aponta para um servidor
// Evolution API seu e pareia um número lendo um QR code.
//
// Por que o POST faz tanta coisa (cria a instância, grava o webhook,
// gera segredo): porque a alternativa é o usuário fazer isso à mão em
// três lugares e errar em um. O erro mais comum — webhook apontando
// para lugar nenhum — não dá sintoma: o número conecta, o QR some, e as
// mensagens simplesmente não chegam no CRM.
// ============================================================

import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  loadChannelByKind,
  evolutionCredentials,
} from '@/lib/whatsapp/channels';
import {
  EvolutionError,
  connectionState,
  ensureInstance,
  pairingQrCode,
  setWebhook,
} from '@/lib/whatsapp/providers/evolution';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/** Nome de instância: o que o Evolution aceita na URL sem escapar. */
const INSTANCE_RE = /^[a-zA-Z0-9_-]{3,60}$/;

/**
 * URL do webhook que o Evolution vai chamar, com o segredo embutido.
 *
 * O segredo vai na querystring porque o Evolution não assina o corpo
 * como a Meta faz — é a única prova de origem possível. Por isso ele
 * identifica o canal e nada mais: quem o obtiver consegue INJETAR
 * mensagem falsa nesta caixa de entrada, não ler nem enviar.
 */
function webhookUrlFor(secret: string): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/$/, '');
  return `${base}/api/whatsapp/webhook/evolution?s=${secret}`;
}

/** Forma pública do canal. Nunca inclui chave nem segredo. */
function publicShape(
  channel: {
    id: string;
    label: string | null;
    display_number: string | null;
    status: string;
    provider_base_url: string | null;
    provider_instance: string | null;
    created_at?: string;
  } | null
) {
  if (!channel) return null;
  return {
    id: channel.id,
    label: channel.label,
    display_number: channel.display_number,
    status: channel.status,
    provider_base_url: channel.provider_base_url,
    provider_instance: channel.provider_instance,
  };
}

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const channel = await loadChannelByKind(supabase, accountId, 'unofficial');

    if (!channel) {
      return NextResponse.json({ configured: false, channel: null });
    }

    // Estado vivo do provedor, não o que está gravado: a sessão cai
    // sozinha (QR expirado, celular fora do ar por muito tempo) e o
    // banco só descobre isso quando chega um CONNECTION_UPDATE. Sem
    // perguntar aqui, a tela mentiria "conectado" para uma sessão morta.
    let state: 'open' | 'connecting' | 'close' | 'unreachable';
    let qr: string | null = null;
    try {
      const auth = evolutionCredentials(channel);
      state = await connectionState(auth);
      if (state !== 'open') {
        qr = (await pairingQrCode(auth)).base64;
      }
    } catch (err) {
      console.error('[channels/unofficial] provider unreachable:', err);
      state = 'unreachable';
    }

    // Espelha no banco para a inbox não precisar consultar o provedor.
    const dbStatus =
      state === 'open'
        ? 'connected'
        : state === 'connecting'
          ? 'connecting'
          : 'disconnected';
    if (dbStatus !== channel.status) {
      await supabase
        .from('whatsapp_config')
        .update({ status: dbStatus, updated_at: new Date().toISOString() })
        .eq('id', channel.id);
    }

    return NextResponse.json({
      configured: true,
      channel: { ...publicShape(channel), status: dbStatus },
      state,
      qr_base64: qr,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');

    // `adminAction`: cadastrar canal é operação de admin e cada chamada
    // bate no servidor do provedor, então não pode ser barata de repetir.
    const limit = checkRateLimit(
      `channel-unofficial:${accountId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => ({}));
    const baseUrl = String(body.provider_base_url ?? '').trim();
    const instance = String(body.provider_instance ?? '').trim();
    const apiKey = String(body.provider_api_key ?? '').trim();
    const label = String(body.label ?? 'WhatsApp não-oficial')
      .trim()
      .slice(0, 80);
    const displayNumber = String(body.display_number ?? '')
      .trim()
      .slice(0, 32);

    if (!/^https:\/\/.+/i.test(baseUrl)) {
      return NextResponse.json(
        {
          error:
            'provider_base_url deve ser uma URL https. Sem TLS, a chave da API e o conteúdo das mensagens trafegam em texto claro.',
        },
        { status: 400 }
      );
    }
    if (!INSTANCE_RE.test(instance)) {
      return NextResponse.json(
        {
          error:
            'provider_instance deve ter de 3 a 60 caracteres, só letras, números, hífen ou sublinhado.',
        },
        { status: 400 }
      );
    }
    if (!process.env.NEXT_PUBLIC_SITE_URL) {
      return NextResponse.json(
        {
          error:
            'NEXT_PUBLIC_SITE_URL não está configurada no servidor — sem ela não há como dizer ao provedor para onde mandar as mensagens recebidas.',
        },
        { status: 500 }
      );
    }

    const existing = await loadChannelByKind(supabase, accountId, 'unofficial');

    // Chave em branco numa EDIÇÃO significa "mantenha a que está lá",
    // que é o que a tela promete — ela nunca reexibe a chave, então
    // exigir que o usuário a redigitasse para trocar o rótulo do número
    // seria pedir que ele fosse buscá-la no servidor de novo.
    // Num cadastro novo não há o que manter: aí ela é obrigatória.
    let effectiveApiKey = apiKey;
    if (!effectiveApiKey) {
      if (!existing) {
        return NextResponse.json(
          { error: 'provider_api_key é obrigatória.' },
          { status: 400 }
        );
      }
      try {
        effectiveApiKey = evolutionCredentials(existing).apiKey;
      } catch {
        return NextResponse.json(
          {
            error:
              'A chave guardada não pôde ser decifrada (o ENCRYPTION_KEY mudou?). Informe a chave de novo.',
          },
          { status: 400 }
        );
      }
    }

    // O segredo do webhook é preservado entre edições: trocá-lo sem
    // necessidade invalidaria o webhook já gravado no provedor e as
    // mensagens parariam de chegar sem nenhum erro visível.
    const webhookSecret =
      existing?.webhook_secret ?? randomBytes(24).toString('hex');
    const webhookUrl = webhookUrlFor(webhookSecret);

    // Fala com o provedor ANTES de gravar: um canal salvo apontando para
    // um servidor que não responde é pior do que nenhum canal, porque a
    // tela diz "configurado".
    try {
      await ensureInstance(
        { baseUrl, instance, apiKey: effectiveApiKey },
        webhookUrl
      );
      await setWebhook(
        { baseUrl, instance, apiKey: effectiveApiKey },
        webhookUrl
      );
    } catch (err) {
      const message = err instanceof EvolutionError ? err.message : String(err);
      const status = err instanceof EvolutionError ? err.status : null;
      return NextResponse.json(
        {
          error:
            status === 401 || status === 403
              ? 'O servidor respondeu, mas recusou a chave da API.'
              : `Não consegui falar com o servidor do provedor: ${message}`,
        },
        { status: 400 }
      );
    }

    const row = {
      account_id: accountId,
      user_id: userId,
      kind: 'unofficial' as const,
      label: label || 'WhatsApp não-oficial',
      display_number: displayNumber || null,
      provider_base_url: baseUrl.replace(/\/$/, ''),
      provider_instance: instance,
      provider_api_key: encrypt(effectiveApiKey),
      webhook_secret: webhookSecret,
      status: 'connecting',
      updated_at: new Date().toISOString(),
    };

    const { data: saved, error: saveError } = existing
      ? await supabase
          .from('whatsapp_config')
          .update(row)
          .eq('id', existing.id)
          .select('*')
          .single()
      : await supabase.from('whatsapp_config').insert(row).select('*').single();

    if (saveError || !saved) {
      console.error('[channels/unofficial] save failed:', saveError);
      return NextResponse.json(
        { error: 'Não foi possível salvar o canal.' },
        { status: 500 }
      );
    }

    // QR já na resposta: o pareamento é o próximo passo inevitável, e o
    // código expira em segundos — devolver aqui poupa um ida-e-volta.
    let qr: string | null = null;
    try {
      qr = (await pairingQrCode({ baseUrl, instance, apiKey: effectiveApiKey }))
        .base64;
    } catch (err) {
      console.warn('[channels/unofficial] QR not available yet:', err);
    }

    return NextResponse.json({
      configured: true,
      channel: publicShape(saved),
      qr_base64: qr,
      webhook_url: webhookUrl,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin');

    const channel = await loadChannelByKind(supabase, accountId, 'unofficial');
    if (!channel) {
      return NextResponse.json({ configured: false });
    }

    // A instância no provedor NÃO é apagada de propósito: apagar
    // desconecta o número e joga fora a sessão pareada, e isso tem de ser
    // uma decisão explícita tomada lá, não um efeito colateral de
    // remover o canal daqui. As conversas também sobrevivem — o
    // channel_id vira NULL (ON DELETE SET NULL, migration 043).
    const { error } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('id', channel.id);

    if (error) {
      console.error('[channels/unofficial] delete failed:', error);
      return NextResponse.json(
        { error: 'Não foi possível remover o canal.' },
        { status: 500 }
      );
    }

    return NextResponse.json({ configured: false });
  } catch (err) {
    return toErrorResponse(err);
  }
}
