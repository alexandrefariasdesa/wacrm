"use client";

import { useState } from "react";
import { Check, Plus } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { createClient } from "@/lib/supabase/client";
import { emitContactTagsChanged } from "@/lib/inbox/tag-events";
import { canCreateTag, filterTagOptions, pickTagColor } from "@/lib/inbox/tag-picker";
import type { Tag } from "@/types";

export type AssignedTag = Tag & { contact_tag_id: string };

interface Props {
  contactId: string;
  assigned: AssignedTag[];
  onChange: (next: AssignedTag[]) => void;
}

/** "+" ao lado das etiquetas do contato: marca/desmarca e, para admins, cria etiqueta nova. */
export function ContactTagPicker({ contactId, assigned, onChange }: Props) {
  const t = useTranslations("Inbox.sidebar");
  const { accountId } = useAuth();
  const canSend = useCan("send-messages");
  const canCreate = useCan("edit-settings"); // policy tags_insert exige admin
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<Tag[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const { data } = await createClient().from("tags").select("*").order("name");
    setAll((data ?? []) as Tag[]);
  }

  function publish(next: AssignedTag[]) {
    onChange(next);
    emitContactTagsChanged(contactId, next);
  }

  async function link(tag: Tag) {
    const { data, error } = await createClient()
      .from("contact_tags")
      .insert({ contact_id: contactId, tag_id: tag.id })
      .select("id")
      .single();
    // 23505 = já estava ligada (outro atendente/aba): tratar como sucesso silencioso.
    if (error && error.code !== "23505") throw error;
    const id = (data as { id: string } | null)?.id;
    if (id && !assigned.some((a) => a.id === tag.id)) publish([...assigned, { ...tag, contact_tag_id: id }]);
  }

  async function toggle(tag: Tag) {
    if (busy) return;
    setBusy(true);
    try {
      const current = assigned.find((a) => a.id === tag.id);
      if (current) {
        const { error } = await createClient().from("contact_tags").delete().eq("id", current.contact_tag_id);
        if (error) throw error;
        publish(assigned.filter((a) => a.id !== tag.id));
      } else {
        await link(tag);
      }
    } catch {
      toast.error(t("tagError"));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    const name = query.trim();
    if (!name || !accountId || busy) return;
    setBusy(true);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("tags")
        .insert({ account_id: accountId, user_id: user?.id, name, color: pickTagColor(name) })
        .select("*")
        .single();
      if (error || !data) throw error ?? new Error("no data");
      const tag = data as Tag;
      setAll((prev) => [...(prev ?? []), tag].sort((a, b) => a.name.localeCompare(b.name)));
      setQuery("");
      await link(tag);
    } catch {
      toast.error(t("tagError"));
    } finally {
      setBusy(false);
    }
  }

  const options = filterTagOptions(all ?? [], query);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) void load();
      }}
    >
      <PopoverTrigger
        disabled={!canSend}
        title={t("addTag")}
        className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus className="h-3 w-3" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchTags")}
          className="w-full rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50"
        />
        <div className="max-h-56 space-y-0.5 overflow-y-auto">
          {all === null ? null : options.length === 0 && !(canCreate && canCreateTag(query, all)) ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">{t("noTagResults")}</p>
          ) : (
            options.map((tag) => {
              const on = assigned.some((a) => a.id === tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void toggle(tag)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted disabled:opacity-60"
                >
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
                  <span className="flex-1 truncate">{tag.name}</span>
                  {on && <Check className="h-3 w-3 text-primary" />}
                </button>
              );
            })
          )}
          {all !== null && canCreate && canCreateTag(query, all) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void create()}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-primary hover:bg-muted disabled:opacity-60"
            >
              <Plus className="h-3 w-3" />
              <span className="truncate">{t("createTag", { name: query.trim() })}</span>
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
