import type { Tag } from "@/types";

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

const PALETTE = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6", "#ec4899", "#64748b"];

export function filterTagOptions(all: Tag[], query: string): Tag[] {
  const q = fold(query);
  return q ? all.filter((t) => fold(t.name).includes(q)) : all;
}

export function canCreateTag(query: string, all: Tag[]): boolean {
  const q = fold(query);
  return q.length > 0 && !all.some((t) => fold(t.name) === q);
}

export function pickTagColor(name: string): string {
  let h = 0;
  for (const ch of fold(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
