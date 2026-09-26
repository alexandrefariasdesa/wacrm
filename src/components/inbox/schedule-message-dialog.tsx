"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Clock } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { defaultLocalSlot, localToIso } from "@/lib/scheduled-messages/local-time";
import { BODY_MAX, MIN_LEAD_MS } from "@/lib/scheduled-messages/constants";

type Status = "pending" | "sending" | "sent" | "failed" | "missed" | "cancelled";

interface Item {
  id: string;
  body: string;
  scheduled_for: string;
  status: Status;
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  initialText: string;
  /** Quantas agendadas pendentes/enviando a conversa tem (para o contador do botão). */
  onChanged: (pendingCount: number) => void;
}

export function ScheduleMessageDialog({
  open,
  onOpenChange,
  conversationId,
  initialText,
  onChanged,
}: Props) {
  const t = useTranslations("Inbox.schedule");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [body, setBody] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [saving, setSaving] = useState(false);
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const load = useCallback(async () => {
    const res = await fetch(`/api/whatsapp/scheduled?conversation_id=${conversationId}`);
    if (!res.ok) return;
    const data = (await res.json()) as { items: Item[] };
    setItems(data.items);
    onChanged(
      data.items.filter((i) => i.status === "pending" || i.status === "sending").length,
    );
  }, [conversationId, onChanged]);

  // Ao abrir: sugere horário, traz o texto do compositor, recarrega a lista.
  useEffect(() => {
    if (!open) return;
    const slot = defaultLocalSlot(new Date());
    setDate(slot.date);
    setTime(slot.time);
    setBody(initialText);
    void load();
  }, [open, initialText, load]);

  const iso = localToIso(date, time);
  const inFuture = iso !== null && new Date(iso).getTime() >= Date.now() + MIN_LEAD_MS;
  const canSave = !saving && body.trim().length > 0 && body.length <= BODY_MAX && inFuture;

  async function schedule() {
    if (!canSave || !iso) return;
    setSaving(true);
    try {
      const res = await fetch("/api/whatsapp/scheduled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId, body, scheduled_for: iso }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("error"));
        return;
      }
      toast.success(t("scheduled"));
      setBody("");
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function cancel(id: string) {
    const res = await fetch(`/api/whatsapp/scheduled/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? t("error"));
    }
    await load();
  }

  const fmt = (v: string) =>
    new Date(v).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4" /> {t("title")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="flex-1 rounded-md border border-border bg-muted px-3 py-2 text-sm"
            />
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="w-32 rounded-md border border-border bg-muted px-3 py-2 text-sm"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">{t("timezone", { tz })}</p>
          {!inFuture && date && time && (
            <p className="text-xs text-amber-400">{t("pastWarning")}</p>
          )}
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            maxLength={BODY_MAX}
            placeholder={t("bodyPlaceholder")}
            className="w-full resize-none rounded-md border border-border bg-muted px-3 py-2 text-sm"
          />
        </div>

        <div className="max-h-48 space-y-2 overflow-y-auto">
          {items.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("empty")}</p>
          ) : (
            items.map((i) => (
              <div key={i.id} className="rounded-md border border-border p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{fmt(i.scheduled_for)}</span>
                  <span className="text-muted-foreground">{t(`status.${i.status}`)}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-muted-foreground">{i.body}</p>
                {i.last_error && i.status !== "sent" && (
                  <p className="mt-1 text-red-400">{i.last_error}</p>
                )}
                {i.status === "pending" && (
                  <button
                    type="button"
                    onClick={() => void cancel(i.id)}
                    className="mt-1 text-primary hover:underline"
                  >
                    {t("cancel")}
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("close")}
          </Button>
          <Button disabled={!canSave} onClick={() => void schedule()}>
            {saving ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Clock className="mr-1 h-4 w-4" />
            )}
            {t("schedule")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
