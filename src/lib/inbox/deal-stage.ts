export const canChangeStage = (status: string | null | undefined) => status === "open";

export function sortStages<T extends { position: number }>(stages: T[]): T[] {
  return [...stages].sort((a, b) => a.position - b.position);
}
