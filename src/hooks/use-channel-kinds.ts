"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { ChannelKind } from "@/lib/storage/upload-media";

/** Tipos dos canais da conta (só `id` e `kind`; nunca credenciais). Qualquer membro lê (RLS). */
export function useChannelKinds() {
  const [state, setState] = useState<{ byId: Record<string, ChannelKind>; loaded: boolean }>({
    byId: {},
    loaded: false,
  });

  useEffect(() => {
    let alive = true;
    void createClient()
      .from("whatsapp_config")
      .select("id, kind")
      .then(({ data }) => {
        if (!alive) return;
        const byId: Record<string, ChannelKind> = {};
        for (const row of (data ?? []) as { id: string; kind: ChannelKind }[]) byId[row.id] = row.kind;
        setState({ byId, loaded: true });
      });
    return () => {
      alive = false;
    };
  }, []);

  return {
    byId: state.byId,
    loaded: state.loaded,
    hasUnofficial: Object.values(state.byId).includes("unofficial"),
  };
}
