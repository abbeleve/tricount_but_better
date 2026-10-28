/**
 * Expenses started but not yet added: a scanned receipt checked halfway, a
 * list typed in a shop. Kept on this device only, per signed-in user, until
 * the expense is added or the draft deleted -- never sent to the server, so
 * nothing unsaved ever leaves the phone.
 */

const PREFIX = "tbb.draft.";
// A draft nobody came back to in a month is not coming back.
const MAX_AGE_DAYS = 30;

/** Which form a draft belongs to: a new expense, or a plan being bought. */
export type DraftSlot = { kind: "new" } | { kind: "plan"; planId: string };

export interface DraftSummary {
  title: string;
  /** Sum of the lines, in minor units. */
  total: number;
  lines: number;
  currency: string;
}

export interface StoredDraft<T> {
  savedAt: string;
  summary: DraftSummary;
  data: T;
}

export interface ListedDraft {
  key: string;
  slot: DraftSlot;
  savedAt: string;
  summary: DraftSummary;
}

function teamPrefix(userId: string, teamId: string): string {
  return `${PREFIX}${userId}.${teamId}.`;
}

export function draftKey(userId: string, teamId: string, slot: DraftSlot): string {
  return teamPrefix(userId, teamId) + (slot.kind === "plan" ? `plan-${slot.planId}` : "new");
}

/** The form that carries on with a draft. */
export function draftPath(teamId: string, slot: DraftSlot): string {
  return slot.kind === "plan"
    ? `/teams/${teamId}/expenses/new?planId=${encodeURIComponent(slot.planId)}`
    : `/teams/${teamId}/expenses/new`;
}

function parseSlot(rest: string): DraftSlot | null {
  if (rest === "new") return { kind: "new" };
  if (rest.startsWith("plan-") && rest.length > 5) return { kind: "plan", planId: rest.slice(5) };
  return null;
}

function tooOld(savedAt: string, now: number): boolean {
  const time = Date.parse(savedAt);
  return !Number.isFinite(time) || now - time > MAX_AGE_DAYS * 86_400_000;
}

export function readDraft<T>(key: string, now = Date.now()): StoredDraft<T> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const draft = JSON.parse(raw) as StoredDraft<T>;
    if (!draft || typeof draft !== "object" || !draft.summary || tooOld(draft.savedAt, now)) {
      localStorage.removeItem(key);
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

export function writeDraft<T>(key: string, data: T, summary: DraftSummary, now = Date.now()): void {
  const draft: StoredDraft<T> = { savedAt: new Date(now).toISOString(), summary, data };
  try {
    localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    /* private browsing or a full disk: the form simply is not kept */
  }
}

export function removeDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to remove from */
  }
}

function keysStartingWith(prefix: string): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
  } catch {
    /* storage unavailable: no drafts */
  }
  return keys;
}

/** A team's drafts for this user, newest first. */
export function listDrafts(userId: string, teamId: string, now = Date.now()): ListedDraft[] {
  const prefix = teamPrefix(userId, teamId);
  const drafts: ListedDraft[] = [];
  for (const key of keysStartingWith(prefix)) {
    const slot = parseSlot(key.slice(prefix.length));
    const draft = slot && readDraft(key, now);
    if (slot && draft) drafts.push({ key, slot, savedAt: draft.savedAt, summary: draft.summary });
  }
  return drafts.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** Signing out leaves nothing of this user's behind on a shared device. */
export function removeUserDrafts(userId: string): void {
  for (const key of keysStartingWith(`${PREFIX}${userId}.`)) removeDraft(key);
}
