import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import {
  accountDraftPrefix,
  writePendingBoard,
  listAccountDrafts,
  enqueueUpdateBatch,
  discardPendingBoard,
  discardReviewedDraft,
  readPendingBoard,
  listUpdateBatches,
} from "./pending-board";
import type { NativeBoardSnapshot } from "./runtime/snapshot";
describe("account draft isolation", () => {
  it("discards only reviewed versions and preserves another tab’s newer snapshot and operation", async () => {
    const key = `${accountDraftPrefix("race-installation", "alice")}1:board%3Arace`;
    const pending = {
      snapshot: { workspaceId: key, root: "", docs: {} } as NativeBoardSnapshot,
      baseRevision: 1,
      documentEpoch: "epoch",
      generation: 1,
      savedAt: "2026-10-03T00:00:00Z",
    };
    const batch = {
      key: `${key}:old`,
      boardKey: key,
      operationId: "old",
      documentEpoch: "epoch",
      updates: [],
      createdAt: pending.savedAt,
    };
    await writePendingBoard(key, pending);
    await enqueueUpdateBatch(batch);
    const reviewed = (await listAccountDrafts("race-installation", "alice"))[0];
    await writePendingBoard(key, { ...pending, generation: 2 });
    await enqueueUpdateBatch({
      ...batch,
      key: `${key}:new`,
      operationId: "new",
    });
    await discardReviewedDraft(reviewed);
    expect((await readPendingBoard(key))?.generation).toBe(2);
    expect(
      (await listUpdateBatches(key)).map((item) => item.operationId),
    ).toEqual(["new"]);
    await discardReviewedDraft(
      (await listAccountDrafts("race-installation", "alice"))[0],
    );
    expect(await readPendingBoard(key)).toBeUndefined();
    expect(await listUpdateBatches(key)).toEqual([]);
  });
  it("keeps tenants and user ID prefixes separate while preserving older epochs and owned legacy drafts", async () => {
    const ns = "installation:first",
      owner = "user:alice";
    const keys = [
      `${accountDraftPrefix(ns, owner)}1:board%3Aone`,
      `${accountDraftPrefix(ns, owner)}2:board%3Atwo`,
      `${accountDraftPrefix(ns, "user:alice:other")}1:board%3Aprivate`,
      `${accountDraftPrefix("installation:other", owner)}1:board%3Aprivate`,
      `${owner}:board:legacy`,
    ];
    for (const key of keys)
      await writePendingBoard(key, {
        snapshot: {
          workspaceId: key,
          root: "",
          docs: {},
        } as NativeBoardSnapshot,
        baseRevision: 1,
        documentEpoch: "epoch",
        generation: 1,
        savedAt: new Date().toISOString(),
      });
    await enqueueUpdateBatch({
      key: `${keys[0]}:operation`,
      boardKey: keys[0],
      operationId: "operation",
      documentEpoch: "epoch",
      updates: [{ docId: null, update: "fixture" }],
      createdAt: new Date().toISOString(),
    });
    const rows = await listAccountDrafts(ns, owner);
    expect(rows.map((row) => row.key).sort()).toEqual(
      [keys[0], keys[1], keys[4]].sort(),
    );
    expect(rows.find((row) => row.key === keys[0])?.batches).toHaveLength(1);
    await discardPendingBoard(keys[0]);
    expect(
      (await listAccountDrafts(ns, owner)).map((row) => row.key),
    ).not.toContain(keys[0]);
    expect(await listAccountDrafts(ns, "user:alice:other")).toHaveLength(1);
  });
});
