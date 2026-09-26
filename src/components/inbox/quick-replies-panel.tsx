"use client";

import { useEffect, useState } from "react";
import { Loader2, Search, Zap } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { useCan } from "@/hooks/use-can";
import { panelItems, quickReplyPreview } from "@/lib/inbox/quick-reply-panel";
import type { QuickReply } from "@/types";

interface Props {
  conversationId: string | null;
}

/** Mensagens rápidas na lateral do lead: um clique envia para a conversa aberta. */
export function QuickRepliesPanel({ conversationId }: Props) {
  const t = useTranslations("Inbox.sidebar");
  const tQr = useTranslations("QuickReplies");
  const canSend = useCan("send-messages");
  const [items, setItems] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [sendingId, setSendingId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/quick-replies", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (alive && res.ok) setItems((data.quick_replies as QuickReply[]) ?? []);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [conversationId]);

  const labels = {
    text: tQr("stepText"),
    image: tQr("stepImage"),
    video: tQr("stepVideo"),
    document: tQr("stepDocument"),
  };
  const all = panelItems(items, "");
  const shown = panelItems(items, query);

  async function send(qr: QuickReply) {
    if (!conversationId || sendingId) return;
    setSendingId(qr.id);
    try {
      const res = await fetch(`/api/quick-replies/${qr.id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("quickReplyError"));
        return;
      }
      toast.success(
        qr.kind === "sequence"
          ? t("quickReplySequenceSent", { count: data.steps ?? 0 })
          : t("quickReplySent"),
      );
    } catch {
      toast.error(t("quickReplyError"));
    } finally {
      setSendingId(null);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Zap className="h-3 w-3" />
        {t("quickReplies")}
      </div>

      {all.length > 6 && (
        <label className="mt-2 flex items-center gap-1.5 rounded-lg border border-border bg-muted px-2 py-1">
          <Search className="h-3 w-3 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("quickRepliesSearch")}
            className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      )}

      <div className="mt-2 space-y-1">
        {loading ? (
          <div className="flex justify-center py-3">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : all.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">{t("quickRepliesEmpty")}</p>
        ) : (
          shown.map((qr) => (
            <button
              key={qr.id}
              type="button"
              onClick={() => void send(qr)}
              disabled={!canSend || !conversationId || sendingId !== null}
              className="flex w-full items-start gap-2 rounded-lg bg-muted px-3 py-2 text-left transition-colors hover:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">{qr.title}</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {quickReplyPreview(qr, labels)}
                </p>
              </div>
              {sendingId === qr.id && <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" />}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
