import type { QuickReply } from "@/types";
import { describeSteps, type StepType } from "@/lib/quick-replies/steps";

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function quickReplyPreview(qr: QuickReply, labels: Record<StepType, string>): string {
  if (qr.kind === "sequence") return describeSteps(qr.steps ?? [], labels);
  return qr.content_text ?? "";
}

/** Itens do painel lateral: sem interativas; busca por título e conteúdo, sem caixa nem acento. */
export function panelItems(items: QuickReply[], query: string): QuickReply[] {
  const q = fold(query.trim());
  return items
    .filter((i) => i.kind !== "interactive")
    .filter((i) => !q || fold(i.title).includes(q) || fold(i.content_text ?? "").includes(q));
}
