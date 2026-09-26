"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CHAT_MEDIA_BUCKET } from "@/components/inbox/message-composer";
import { useChannelKinds } from "@/hooks/use-channel-kinds";
import { deleteAccountMedia, mediaMaxBytes, uploadAccountMedia } from "@/lib/storage/upload-media";
import {
  MAX_STEPS,
  MAX_STEP_DELAY_S,
  totalDelaySeconds,
  type SequenceStep,
  type StepType,
} from "@/lib/quick-replies/steps";

const STEP_TYPES: StepType[] = ["text", "image", "video", "document"];

// Mesmos tipos aceitos pelo bucket `chat-media` (migration 023) e pelo compositor.
const ACCEPT: Record<Exclude<StepType, "text">, string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
};

interface Props {
  value: SequenceStep[];
  onChange: (steps: SequenceStep[]) => void;
}

/** Editor da lista de passos de uma sequência (texto, imagem, vídeo, documento + espera). */
export function SequenceEditor({ value, onChange }: Props) {
  const t = useTranslations("QuickReplies");
  const { hasUnofficial } = useChannelKinds();
  const [uploading, setUploading] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // O upload demora: ao terminar, o que vale é o rascunho DE AGORA (o atendente pode ter editado
  // outro passo ou o título enquanto subia), não o de quando o envio começou.
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
  });
  const pendingIndex = useRef<number>(-1);
  // Caminho do arquivo que ESTE editor subiu, por passo — só esses podem ser apagados ao trocar.
  const uploadedPaths = useRef<Map<number, string>>(new Map());

  const labels: Record<StepType, string> = {
    text: t("stepText"),
    image: t("stepImage"),
    video: t("stepVideo"),
    document: t("stepDocument"),
  };

  const update = (i: number, patch: Partial<SequenceStep>) =>
    onChange(value.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const changeType = (i: number, type: StepType) => {
    const cur = value[i];
    if (cur.type === type) return;
    const base: SequenceStep = { type, delay_seconds: cur.delay_seconds };
    onChange(value.map((s, idx) => (idx === i ? (type === "text" ? { ...base, text: "" } : base) : s)));
  };

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    // Os caminhos guardados acompanham a troca de posição.
    const m = uploadedPaths.current;
    const a = m.get(i);
    const b = m.get(j);
    if (a !== undefined) m.set(j, a); else m.delete(j);
    if (b !== undefined) m.set(i, b); else m.delete(i);
  };

  const remove = (i: number) => {
    const path = uploadedPaths.current.get(i);
    if (path) void deleteAccountMedia(CHAT_MEDIA_BUCKET, path).catch(() => {});
    const m = new Map<number, string>();
    uploadedPaths.current.forEach((p, idx) => {
      if (idx < i) m.set(idx, p);
      else if (idx > i) m.set(idx - 1, p);
    });
    uploadedPaths.current = m;
    onChange(value.filter((_, idx) => idx !== i));
  };

  const add = () => {
    if (value.length >= MAX_STEPS) return;
    onChange([...value, { type: "text", text: "", delay_seconds: 0 }]);
  };

  const pickFile = (i: number) => {
    pendingIndex.current = i;
    const step = value[i];
    if (fileRef.current && step.type !== "text") {
      fileRef.current.accept = ACCEPT[step.type];
      fileRef.current.click();
    }
  };

  const onFile = async (file: File | undefined) => {
    const i = pendingIndex.current;
    if (!file || i < 0) return;
    const step = value[i];
    if (!step || step.type === "text") return;
    const max = mediaMaxBytes(step.type, hasUnofficial ? "unofficial" : null);
    if (file.size > max) {
      toast.error(
        t("fileTooBig", {
          size: (file.size / 1024 / 1024).toFixed(1),
          max: Math.round(max / 1024 / 1024),
        }),
      );
      return;
    }
    setUploading(i);
    try {
      const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
      const old = uploadedPaths.current.get(i);
      if (old) void deleteAccountMedia(CHAT_MEDIA_BUCKET, old).catch(() => {});
      uploadedPaths.current.set(i, path);
      const latest = valueRef.current;
      onChangeRef.current(
        latest.map((s, idx) =>
          idx === i
            ? { ...s, media_url: publicUrl, filename: s.type === "document" ? file.name : s.filename }
            : s,
        ),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(null);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("sequenceHelp")}</p>

      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {value.map((step, i) => (
        <div key={i} className="space-y-2 rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">{i + 1}.</span>
            <div className="flex flex-1 flex-wrap gap-1">
              {STEP_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => changeType(i, type)}
                  className={
                    step.type === type
                      ? "rounded-md border border-primary bg-primary/10 px-2 py-1 text-xs font-medium text-primary"
                      : "rounded-md border border-border bg-muted px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                  }
                >
                  {labels[type]}
                </button>
              ))}
            </div>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => move(i, -1)} disabled={i === 0} title={t("moveUp")}>
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => move(i, 1)} disabled={i === value.length - 1} title={t("moveDown")}>
              <ArrowDown className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => remove(i)}
              disabled={value.length === 1}
              title={t("removeStep")}
              className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>

          {step.type === "text" ? (
            <Textarea
              value={step.text ?? ""}
              onChange={(e) => update(i, { text: e.target.value })}
              placeholder={t("textPlaceholder")}
              className="min-h-20 bg-muted text-foreground"
            />
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => pickFile(i)} disabled={uploading !== null}>
                  {uploading === i ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="mr-1 h-4 w-4" />
                  )}
                  {step.media_url ? t("replaceFile") : t("uploadFile")}
                </Button>
                {step.media_url && (
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {step.filename ?? step.media_url.split("/").pop()}
                  </span>
                )}
              </div>
              {step.type !== "document" && (
                <Input
                  value={step.caption ?? ""}
                  onChange={(e) => update(i, { caption: e.target.value })}
                  placeholder={t("caption")}
                  maxLength={1024}
                  className="bg-muted text-foreground"
                />
              )}
            </div>
          )}

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            {t("waitSeconds")}
            <Input
              type="number"
              min={0}
              max={MAX_STEP_DELAY_S}
              value={step.delay_seconds}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                update(i, { delay_seconds: Number.isFinite(n) ? Math.min(MAX_STEP_DELAY_S, Math.max(0, n)) : 0 });
              }}
              className="h-7 w-20 bg-muted text-foreground"
            />
          </label>
        </div>
      ))}

      <div className="flex items-center justify-between">
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={value.length >= MAX_STEPS}>
          <Plus className="mr-1 h-4 w-4" />
          {t("addStep")}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t("totalWait", { seconds: totalDelaySeconds(value) })}
        </span>
      </div>
    </div>
  );
}
