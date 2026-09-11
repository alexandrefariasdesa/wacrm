'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  QrCode,
  Trash2,
  XCircle,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

type State = 'open' | 'connecting' | 'close' | 'unreachable';

interface Channel {
  id: string;
  label: string | null;
  display_number: string | null;
  status: string;
  provider_base_url: string | null;
  provider_instance: string | null;
}

const MASKED = '••••••••••••••••';

/** De quanto em quanto tempo perguntamos se o QR já foi lido. */
const PAIRING_POLL_MS = 5000;

/**
 * Cadastro do canal NÃO-OFICIAL (Evolution API).
 *
 * Fica embaixo do cadastro da API oficial, na mesma seção, porque são
 * duas conexões da mesma conta e não dois assuntos diferentes: uma
 * dispara (template aprovado pela Meta), a outra recebe (número pareado
 * por QR). O envio sempre sai pelo canal por onde a conversa entrou.
 */
export function UnofficialChannel() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  const [baseUrl, setBaseUrl] = useState('');
  const [instance, setInstance] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [displayNumber, setDisplayNumber] = useState('');
  const [showKey, setShowKey] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/channels/unofficial');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'falhou');

      setChannel(data.channel ?? null);
      setState(data.state ?? null);
      setQr(data.qr_base64 ?? null);
      if (data.channel) {
        setBaseUrl(data.channel.provider_base_url ?? '');
        setInstance(data.channel.provider_instance ?? '');
        setDisplayNumber(data.channel.display_number ?? '');
        // A chave nunca volta do servidor; o campo fica mascarado e só
        // é enviado de novo se o usuário digitar algo.
        setApiKey('');
      }
    } catch (err) {
      console.error('[unofficial-channel] load failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Enquanto o QR estiver na tela, perguntamos periodicamente se ele já
  // foi lido — o código expira em segundos e o provedor gera outro, então
  // sem isto o usuário ficaria olhando um QR morto.
  useEffect(() => {
    const pairing =
      Boolean(channel) && state !== 'open' && state !== 'unreachable';
    if (!pairing) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    pollRef.current = setInterval(() => void load(), PAIRING_POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [channel, state, load]);

  async function save() {
    if (!baseUrl.trim() || !instance.trim()) {
      toast.error('Informe a URL do servidor e o nome da instância.');
      return;
    }
    if (!channel && !apiKey.trim()) {
      toast.error('Informe a chave da API do servidor.');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp/channels/unofficial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_base_url: baseUrl.trim(),
          provider_instance: instance.trim(),
          // Sem digitar nada = manter a chave atual. O servidor exige a
          // chave, então reenviamos o placeholder só quando há canal.
          provider_api_key: apiKey.trim() || undefined,
          display_number: displayNumber.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Não foi possível salvar.');
        return;
      }
      setChannel(data.channel);
      setQr(data.qr_base64 ?? null);
      setState('connecting');
      setApiKey('');
      toast.success('Canal salvo. Leia o QR code com o celular do número.');
    } catch (err) {
      console.error('[unofficial-channel] save failed:', err);
      toast.error('Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp/channels/unofficial', {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? 'Não foi possível remover.');
        return;
      }
      setChannel(null);
      setState(null);
      setQr(null);
      toast.success('Canal removido. A sessão no servidor continua ativa.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Carregando canais…
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <QrCode className="h-4 w-4" />
          WhatsApp não-oficial (receptivo)
        </CardTitle>
        <CardDescription>
          Um segundo número, pareado por QR code num servidor Evolution API seu.
          Serve o atendimento; o disparo continua saindo pela API oficial. As
          conversas dos dois números caem na mesma caixa de entrada, e a
          resposta sempre sai pelo número por onde ela entrou.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Este canal não é suportado pelo WhatsApp</AlertTitle>
          <AlertDescription>
            Conexão por QR code é uma emulação do WhatsApp Web. Volume alto,
            disparo em massa ou muita mensagem para quem nunca falou com você
            derrubam o número. Aqui não existe template, não existe botão, e o
            anúncio que originou o lead não é identificado — isso só chega pela
            API oficial. Broadcast fica bloqueado neste canal de propósito.
          </AlertDescription>
        </Alert>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="evo-url">URL do servidor</Label>
            <Input
              id="evo-url"
              // O navegador enxerga "URL/servidor/instância" como campos
              // de login e enfia e-mail e senha salvos aqui. Visto na
              // própria tela: o Chrome preencheu o nome da instância com
              // o e-mail do usuário. `off` sozinho o Chrome ignora com
              // frequência; os dois data-* calam 1Password e LastPass.
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://evo.seudominio.com"
            />
            <p className="text-muted-foreground text-xs">
              Precisa ser https — a chave e o conteúdo das mensagens passam por
              aqui.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="evo-instance">Nome da instância</Label>
            <Input
              id="evo-instance"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              value={instance}
              onChange={(e) => setInstance(e.target.value)}
              placeholder="receptivo"
            />
            <p className="text-muted-foreground text-xs">
              Como a sessão se chama dentro do servidor. Letras, números, hífen
              e sublinhado.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="evo-key">Chave da API</Label>
            <div className="relative">
              <Input
                id="evo-key"
                type={showKey ? 'text' : 'password'}
                autoComplete="new-password"
                data-1p-ignore
                data-lpignore="true"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={channel ? MASKED : 'A chave do seu servidor'}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="text-muted-foreground absolute top-1/2 right-3 -translate-y-1/2"
                aria-label={showKey ? 'Ocultar chave' : 'Mostrar chave'}
              >
                {showKey ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            {channel ? (
              <p className="text-muted-foreground text-xs">
                Guardada cifrada. Deixe em branco para manter a atual.
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="evo-number">Número (apenas rótulo)</Label>
            <Input
              id="evo-number"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              value={displayNumber}
              onChange={(e) => setDisplayNumber(e.target.value)}
              placeholder="+55 11 99999-9999"
            />
            <p className="text-muted-foreground text-xs">
              Só para a caixa de entrada mostrar por qual número a conversa
              chegou.
            </p>
          </div>
        </div>

        {channel ? <StatusRow state={state} channel={channel} /> : null}

        {channel && qr && state !== 'open' ? (
          <div className="border-border flex flex-col items-center gap-3 rounded-lg border p-5">
            <p className="text-sm font-medium">
              Leia este código com o celular do número
            </p>
            <p className="text-muted-foreground max-w-md text-center text-xs">
              No WhatsApp do aparelho: Configurações → Dispositivos conectados →
              Conectar um dispositivo. O código expira em segundos; esta tela
              busca um novo sozinha.
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qr}
              alt="QR code de pareamento"
              className="h-56 w-56 rounded bg-white p-2"
            />
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {channel ? 'Salvar alterações' : 'Cadastrar canal'}
          </Button>
          {channel ? (
            <Button variant="outline" onClick={remove} disabled={saving}>
              <Trash2 className="mr-2 h-4 w-4" />
              Remover canal
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function StatusRow({
  state,
  channel,
}: {
  state: State | null;
  channel: Channel;
}) {
  const map: Record<
    State,
    { icon: typeof CheckCircle2; text: string; tone: string }
  > = {
    open: {
      icon: CheckCircle2,
      text: 'Conectado — recebendo mensagens',
      tone: 'text-emerald-600',
    },
    connecting: {
      icon: Loader2,
      text: 'Aguardando a leitura do QR code',
      tone: 'text-amber-600',
    },
    close: {
      icon: XCircle,
      text: 'Desconectado — leia o QR code para reconectar',
      tone: 'text-destructive',
    },
    unreachable: {
      icon: AlertTriangle,
      text: 'O servidor não respondeu. Verifique se ele está no ar e se a URL e a chave estão corretas.',
      tone: 'text-destructive',
    },
  };

  const entry = state ? map[state] : null;
  if (!entry) return null;
  const Icon = entry.icon;

  return (
    <div className="border-border flex items-center gap-2 rounded-lg border px-4 py-3 text-sm">
      <Icon
        className={`h-4 w-4 ${entry.tone} ${state === 'connecting' ? 'animate-spin' : ''}`}
      />
      <span>{entry.text}</span>
      {channel.display_number ? (
        <span className="text-muted-foreground ml-auto text-xs">
          {channel.display_number}
        </span>
      ) : null}
    </div>
  );
}
