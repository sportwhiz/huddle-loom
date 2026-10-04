import { z } from "zod";
import * as Y from "yjs";

const snapshotSchema = z.object({
  format: z.literal("cloudflare-whiteboard/native"),
  version: z.literal(1),
  workspaceId: z.string().max(200),
  root: z.string(),
  docs: z.record(z.string()),
});
const batchSchema = z.object({
  documentEpoch: z.string(),
  updates: z
    .array(z.object({ docId: z.string().nullable(), update: z.string() }))
    .max(180),
});
const assetSchema = z.object({
  boardKey: z.string(),
  key: z.string(),
  contentType: z.string(),
  data: z.string(),
});
const bundleSchema = z.object({
  format: z.literal("cloudflare-whiteboard/account-recovery"),
  version: z.literal(1),
  drafts: z
    .array(
      z.object({
        key: z.string(),
        pending: z
          .object({
            title: z.string().optional(),
            documentEpoch: z.string(),
            snapshot: snapshotSchema,
          })
          .optional(),
        batches: z.array(batchSchema).max(10000),
      }),
    )
    .min(1)
    .max(100),
  assets: z.array(assetSchema).max(10000),
});

function merge(base: string, updates: string[]) {
  if (!updates.length) return base;
  const decode = (value: string) =>
    Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  const bytes = Y.mergeUpdates([decode(base), ...updates.map(decode)]);
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

/** Recovery always creates new boards. It never rewrites a shared board. */
export function recoveryArchives(input: unknown) {
  const bundle = bundleSchema.parse(input);
  return bundle.drafts.map((draft, index) => {
    if (!draft.pending)
      throw new Error(
        "This recovery file contains changes without a complete board snapshot. Keep the file and reopen the original board with the original account to finish syncing.",
      );
    if (
      draft.batches.some(
        (batch) => batch.documentEpoch !== draft.pending!.documentEpoch,
      )
    )
      throw new Error(
        "This recovery file contains different board versions. Keep it for operator-assisted recovery.",
      );
    const snapshot = {
      ...draft.pending.snapshot,
      docs: { ...draft.pending.snapshot.docs },
    };
    const updates = draft.batches.flatMap((batch) => batch.updates);
    snapshot.root = merge(
      snapshot.root,
      updates
        .filter((update) => update.docId === null)
        .map((update) => update.update),
    );
    for (const id of new Set(
      updates.flatMap((update) =>
        update.docId === null ? [] : [update.docId],
      ),
    )) {
      snapshot.docs[id] = merge(
        snapshot.docs[id] ?? "AAA=",
        updates
          .filter((update) => update.docId === id)
          .map((update) => update.update),
      );
    }
    const assets = bundle.assets
      .filter((asset) => asset.boardKey === draft.key)
      .map(({ boardKey, ...asset }) => asset);
    if (assets.length > 100)
      throw new Error(
        "A recovered board has more than 100 cached images. Keep the file for operator-assisted recovery.",
      );
    return {
      format: "cloudflare-whiteboard/archive",
      version: 1,
      createdAt: new Date().toISOString(),
      board: {
        title: (draft.pending.title || `Recovered board ${index + 1}`).slice(
          0,
          100,
        ),
      },
      snapshot,
      assets,
    };
  });
}

export async function prepareImportFiles(file: Blob): Promise<Blob[]> {
  if (file.size > 50 * 1024 * 1024)
    throw new Error("Import files must be smaller than 50 MB.");
  let value;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw new Error("Choose a valid Huddle Loom board or recovery file.");
  }
  if (value?.format !== "cloudflare-whiteboard/account-recovery") return [file];
  try {
    return recoveryArchives(value).map(
      (archive) =>
        new Blob([JSON.stringify(archive)], { type: "application/json" }),
    );
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new Error(
        "The recovery file is incomplete or malformed. Keep the original file.",
      );
    throw error;
  }
}
