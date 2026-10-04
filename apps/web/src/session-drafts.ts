import {
  discardReviewedDraft,
  listAccountDrafts,
  type AccountDraft,
} from "./blocksuite/pending-board";
import { authSnapshot } from "./auth-client";
import type { AuthBootstrap } from "./auth-client";
export type DraftIdentity = { namespace: string; userId: string };
export function draftIdentity(
  value: AuthBootstrap | undefined,
): DraftIdentity | undefined {
  return value?.mode === "native" && value.user && value.cacheNamespace
    ? { namespace: value.cacheNamespace, userId: value.user.id }
    : undefined;
}
export async function flushLocalDrafts() {
  const work: Promise<unknown>[] = [];
  window.dispatchEvent(
    new CustomEvent("canvas-flush-local-drafts", {
      detail: { waitUntil: (promise: Promise<unknown>) => work.push(promise) },
    }),
  );
  await Promise.all(work);
}
export type DraftDecision = {
  identity: DraftIdentity;
  drafts: AccountDraft[];
  resolve: (value: boolean) => void;
};
let decide: ((request: DraftDecision) => void) | undefined;
export function registerDraftDecision(listener: typeof decide) {
  decide = listener;
  return () => {
    if (decide === listener) decide = undefined;
  };
}
export async function prepareAccountExit(identity: DraftIdentity) {
  await flushLocalDrafts();
  const drafts = await listAccountDrafts(identity.namespace, identity.userId);
  if (!drafts.length) return;
  if (
    !decide ||
    !(await new Promise<boolean>((resolve) =>
      decide!({ identity, drafts, resolve }),
    ))
  )
    throw new Error("Sign-out canceled. Your local changes are still here.");
}
export function requireDraftOwner(identity: DraftIdentity) {
  const current = draftIdentity(authSnapshot());
  if (
    !current ||
    current.namespace !== identity.namespace ||
    current.userId !== identity.userId
  )
    throw new Error(
      "Sign in to the original account to recover these changes.",
    );
}
export async function removeDrafts(drafts: AccountDraft[]) {
  for (const draft of drafts) await discardReviewedDraft(draft);
}
export async function downloadDrafts(
  identity: DraftIdentity,
  drafts: AccountDraft[],
) {
  // Each native blob database is scoped to this account, board and document epoch.
  const assets: {
    boardKey: string;
    key: string;
    contentType: string;
    data: string;
  }[] = [];
  requireDraftOwner(identity);
  const available =
    typeof indexedDB.databases === "function"
      ? await indexedDB.databases()
      : undefined;
  const { IndexedDBBlobSource } = await import("@blocksuite/sync");
  for (const draft of drafts) {
    const epoch =
      draft.pending?.documentEpoch ?? draft.batches[0]?.documentEpoch;
    const name = `canvas-blobs:${draft.key}:${encodeURIComponent(epoch ?? "")}`;
    // Opening an empty, account-scoped cache is safe on browsers without inventory.
    if (available && !available.some((db) => db.name === `${name}_blob`))
      continue;
    const source = new IndexedDBBlobSource(name);
    for (const key of await source.list()) {
      const blob = await source.get(key);
      if (!blob) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      assets.push({
        boardKey: draft.key,
        key,
        contentType: blob.type,
        data: btoa(binary),
      });
    }
  }
  requireDraftOwner(identity);
  const file = new Blob(
    [
      JSON.stringify({
        format: "cloudflare-whiteboard/account-recovery",
        version: 1,
        createdAt: new Date().toISOString(),
        ...identity,
        drafts,
        assets,
      }),
    ],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(file),
    link = document.createElement("a");
  link.href = url;
  link.download = "canvas-local-recovery.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
