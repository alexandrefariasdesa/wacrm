"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// Texto fixo em pt-BR de propósito: este aviso é operacional (alguém
// precisa ler o QR agora) e não deve depender do catálogo de idiomas.

interface DownChannel {
  id: string;
  label: string | null;
  display_number: string | null;
  health_changed_at: string | null;
}

const POLL_MS = 60_000;

function since(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.round(h / 24)} dias`;
}

/**
 * Faixa vermelha acima de todas as páginas quando um canal
 * não-oficial está fora do ar.
 *
 * O canal por QR cai sem barulho — o WhatsApp invalida o aparelho e o
 * CRM só recebe silêncio. Sem esta faixa, quem abre o CRM vê tudo
 * normal e uma inbox "calma". Não renderiza nada no caminho feliz.
 */
export function ChannelStatusBanner() {
  const [down, setDown] = useState<DownChannel[]>([]);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    const load = async () => {
      const { data, error } = await supabase
        .from("whatsapp_config")
        .select("id, label, display_number, health_changed_at, health_state, status")
        .eq("kind", "unofficial");
      if (cancelled || error || !data) return;
      setDown(
        data.filter(
          (c) => c.health_state === "down" || c.status === "disconnected"
        )
      );
    };

    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (down.length === 0) return null;

  return (
    <Alert variant="destructive" className="mb-4">
      <TriangleAlert />
      <AlertTitle>WhatsApp desconectado</AlertTitle>
      <AlertDescription>
        {down.map((c) => (
          <span key={c.id} className="block">
            {c.label || c.display_number || "Canal"} está fora do ar
            {c.health_changed_at ? ` ${since(c.health_changed_at)}` : ""}.
            Enquanto isso, mensagens de clientes não chegam aqui.{" "}
            <Link href="/settings" className="font-medium underline">
              Ler o QR de novo
            </Link>
          </span>
        ))}
      </AlertDescription>
    </Alert>
  );
}
