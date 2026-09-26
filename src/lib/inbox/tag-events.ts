import type { Tag } from "@/types";

const EVENT = "inbox:contact-tags-changed";

export interface ContactTagsChanged {
  contactId: string;
  tags: Tag[];
}

/** Avisa a lista de conversas que as etiquetas de um contato mudaram (sem recarregar). */
export function emitContactTagsChanged(contactId: string, tags: Tag[]): void {
  window.dispatchEvent(new CustomEvent<ContactTagsChanged>(EVENT, { detail: { contactId, tags } }));
}

export function onContactTagsChanged(handler: (d: ContactTagsChanged) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<ContactTagsChanged>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
