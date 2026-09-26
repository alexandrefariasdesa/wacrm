import { mediaMaxBytes, type ChannelKind } from "@/lib/storage/upload-media";
import type { SequenceStep } from "./steps";

export interface OversizedMedia {
  index: number;
  type: "image" | "video" | "document";
  bytes: number;
  max: number;
}

/** Tamanho do arquivo em bytes (Content-Length de um HEAD), ou null se não der para saber. */
export type MediaSizeProbe = (url: string) => Promise<number | null>;

export async function headSize(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
    const len = Number(res.headers.get("content-length"));
    return res.ok && Number.isFinite(len) && len > 0 ? len : null;
  } catch {
    return null;
  }
}

/**
 * Só a API oficial da Meta tem tetos menores que o bucket (imagem 5 MB, demais 16 MB): uma sequência
 * salva com um vídeo de 30 MB pelo editor do Evolution falharia no meio se fosse disparada numa conversa
 * dela. Confere ANTES de enviar o 1º passo. Canal desconhecido ou tamanho desconhecido não bloqueiam.
 */
export async function findOversizedMedia(
  steps: SequenceStep[],
  channel: ChannelKind | null,
  probe: MediaSizeProbe = headSize,
): Promise<OversizedMedia | null> {
  if (channel !== "cloud_api") return null;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.type === "text" || !s.media_url) continue;
    const bytes = await probe(s.media_url);
    if (bytes === null) continue;
    const max = mediaMaxBytes(s.type, channel);
    if (bytes > max) return { index: i, type: s.type, bytes, max };
  }
  return null;
}
