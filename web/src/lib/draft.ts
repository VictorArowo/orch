import type { Drafted } from "orch/src/core/events.ts";

// A freshly drafted tree travels from the home page to the editor through
// session storage, along with what drafting it cost.

export interface Draft {
  tree: unknown;
  panel: string;
  drafted?: Drafted;
}

const KEY = "orch:draft";

export function saveDraft(d: Draft) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    // Storage can be unavailable (private windows); the editor will say so.
  }
}

export function loadDraft(): Draft | undefined {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Draft) : undefined;
  } catch {
    return undefined;
  }
}
