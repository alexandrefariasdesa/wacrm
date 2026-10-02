"use client";

import { useCallback, useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import type { Deal } from "@/types";
import { DealStageMenu } from "./deal-stage-menu";

/**
 * Faixa com a etapa do funil dentro da conversa, só no celular (<lg), onde a
 * lateral do lead não aparece. Reaproveita o menu da lateral: escreve
 * `deals.stage_id` direto, então triggers de histórico/Azimute disparam igual.
 */
export function MobileDealStage({ contactId }: { contactId: string }) {
  const [deals, setDeals] = useState<Deal[]>([]);

  const load = useCallback(async () => {
    const { data } = await createClient()
      .from("deals")
      .select("*, stage:pipeline_stages(*)")
      .eq("contact_id", contactId)
      .eq("status", "open")
      .order("created_at", { ascending: false });
    setDeals((data ?? []) as Deal[]);
  }, [contactId]);

  useEffect(() => {
    setDeals([]);
    void load();
  }, [load]);

  if (deals.length === 0) return null;

  return (
    <div className="flex items-center gap-2 overflow-x-auto border-b border-border bg-card px-3 py-2 lg:hidden">
      <span className="shrink-0 text-xs text-muted-foreground">Etapa</span>
      {deals.map((deal) => (
        <DealStageMenu
          key={deal.id}
          deal={deal}
          large
          onMoved={(stageId, stage) =>
            setDeals((prev) =>
              prev.map((d) => (d.id === deal.id ? { ...d, stage_id: stageId, stage } : d)),
            )
          }
        />
      ))}
    </div>
  );
}
