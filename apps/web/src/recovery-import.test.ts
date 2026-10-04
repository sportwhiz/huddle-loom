import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { recoveryArchives, prepareImportFiles } from "./recovery-import";

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
function fixture() {
  const root = new Y.Doc(),
    page = new Y.Doc();
  root.getMap("boards").set("title", "Original");
  page.getMap("notes").set("one", "First idea");
  const snapshot = {
    format: "cloudflare-whiteboard/native",
    version: 1,
    workspaceId: "workspace:fixture",
    root: encode(Y.encodeStateAsUpdate(root)),
    docs: { page: encode(Y.encodeStateAsUpdate(page)) },
  };
  const vector = Y.encodeStateVector(page);
  page.getMap("notes").set("two", "Offline idea");
  return {
    format: "cloudflare-whiteboard/account-recovery",
    version: 1,
    drafts: [
      {
        key: "alice:board",
        pending: {
          title: "Offline brainstorm",
          documentEpoch: "epoch1",
          snapshot,
        },
        batches: [
          {
            documentEpoch: "epoch1",
            updates: [
              {
                docId: "page",
                update: encode(Y.encodeStateAsUpdate(page, vector)),
              },
            ],
          },
        ],
      },
    ],
    assets: [
      {
        boardKey: "alice:board",
        key: "image1",
        contentType: "image/png",
        data: "AA==",
      },
      {
        boardKey: "alice:other-board",
        key: "private-image",
        contentType: "image/png",
        data: "AA==",
      },
    ],
  };
}
describe("local draft recovery import", () => {
  it("merges offline native edits into an independent archive and keeps images scoped to their board", () => {
    const bundle = fixture(),
      original = JSON.stringify(bundle);
    const [archive] = recoveryArchives(bundle);
    const recovered = new Y.Doc();
    Y.applyUpdate(recovered, Buffer.from(archive.snapshot.docs.page, "base64"));
    expect(recovered.getMap("notes").toJSON()).toEqual({
      one: "First idea",
      two: "Offline idea",
    });
    expect(archive.board.title).toBe("Offline brainstorm");
    expect(archive.assets.map((asset) => asset.key)).toEqual(["image1"]);
    expect(JSON.stringify(bundle)).toBe(original);
    expect(archive).not.toHaveProperty("id");
  });
  it("refuses to silently merge edits from a replaced board or an incomplete snapshot", () => {
    const bundle = fixture();
    bundle.drafts[0].batches[0].documentEpoch = "epoch2";
    expect(() => recoveryArchives(bundle)).toThrow("different board versions");
    const missing = fixture();
    delete (missing.drafts[0] as { pending?: unknown }).pending;
    expect(() => recoveryArchives(missing)).toThrow(
      "without a complete board snapshot",
    );
  });
  it("reports malformed files and preserves ordinary board imports", async () => {
    await expect(prepareImportFiles(new Blob(["not json"]))).rejects.toThrow(
      "valid Open Whiteboard",
    );
    const file = new Blob([
      JSON.stringify({ format: "cloudflare-whiteboard/archive", version: 1 }),
    ]);
    expect(await prepareImportFiles(file)).toEqual([file]);
    expect(
      await prepareImportFiles(new Blob([JSON.stringify(fixture())])),
    ).toHaveLength(1);
  });
});
