"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCan } from "@/hooks/use-can";
import { createClient } from "@/lib/supabase/client";
import { canChangeStage, sortStages } from "@/lib/inbox/deal-stage";
import type { Deal, PipelineStage } from "@/types";

interface Props {
  deal: Deal;
  onMoved: (stageId: string, stage: PipelineStage) => void;
  /** Selo maior (alvo de toque) — usado no celular. */
  large?: boolean;
}

/** Selo da etapa do negócio; em negócios abertos vira um menu para trocar de etapa com um clique. */
export function DealStageMenu({ deal, onMoved, large }: Props) {
  const t = useTranslations("Inbox.sidebar");
  const canSend = useCan("send-messages");
  const [stages, setStages] = useState<PipelineStage[] | null>(null);
  const [moving, setMoving] = useState(false);

  const stage = deal.stage;
  if (!stage) return null;

  const sizeClass = large ? "px-3 py-1.5 text-xs" : "px-1.5 py-0.5 text-[10px]";
  const badgeStyle = { backgroundColor: `${stage.color}20`, color: stage.color };

  if (!canChangeStage(deal.status)) {
    return (
      <span className={`rounded-full ${sizeClass}`} style={badgeStyle}>
        {stage.name}
      </span>
    );
  }

  async function loadStages() {
    if (stages) return;
    const { data } = await createClient()
      .from("pipeline_stages")
      .select("*")
      .eq("pipeline_id", deal.pipeline_id);
    setStages(sortStages((data ?? []) as PipelineStage[]));
  }

  async function move(target: PipelineStage) {
    if (target.id === deal.stage_id || moving) return;
    setMoving(true);
    try {
      const { error } = await createClient()
        .from("deals")
        .update({ stage_id: target.id })
        .eq("id", deal.id);
      if (error) {
        toast.error(t("stageMoveError"));
        return;
      }
      onMoved(target.id, target);
      toast.success(t("stageMoved", { stage: target.name }));
    } finally {
      setMoving(false);
    }
  }

  return (
    <DropdownMenu onOpenChange={(open) => open && void loadStages()}>
      <DropdownMenuTrigger
        disabled={!canSend || moving}
        title={t("changeStage")}
        className={`inline-flex items-center gap-1 rounded-full ${sizeClass} disabled:cursor-not-allowed disabled:opacity-60`}
        style={badgeStyle}
      >
        {stage.name}
        <ChevronDown className={large ? "h-3.5 w-3.5" : "h-2.5 w-2.5"} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-64 w-48 border-border bg-popover">
        {(stages ?? [stage]).map((s) => (
          <DropdownMenuItem key={s.id} onClick={() => void move(s)} className="text-sm">
            <span
              className="mr-2 h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: s.color }}
            />
            <span className="flex-1 truncate">{s.name}</span>
            {s.id === deal.stage_id && <Check className="h-3 w-3" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
