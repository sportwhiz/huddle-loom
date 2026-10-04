import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CollaborativeTextDraft } from "./text-draft";

function fixture(value: string) {
  const doc = new Y.Doc();
  const text = doc.getText("note");
  text.insert(0, value);
  const draft = new CollaborativeTextDraft(text);
  return {
    doc,
    text,
    draft,
    edit: (next: string, previous: string) =>
      draft.apply(next, previous, (change) => doc.transact(change, "local")),
  };
}

describe("collaborative sticky typing", () => {
  it("keeps a peer insertion before the caret when a local keystroke uses the previous render", () => {
    const f = fixture("Review request");
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(f.doc));
    peer.getText("note").insert(0, "Please ");
    Y.applyUpdate(f.doc, Y.encodeStateAsUpdate(peer), "native-remote");
    expect(f.edit("Review request today", "Review request")).toBe(
      "Please Review request today",
    );
    f.draft.dispose();
    f.doc.destroy();
    peer.destroy();
  });
  it("keeps a peer suffix while inserting at the original local caret", () => {
    const f = fixture("Start");
    f.doc.transact(() => f.text.insert(5, " → finish"), "peer");
    expect(f.edit("Start now", "Start")).toBe("Start now → finish");
    f.draft.dispose();
    f.doc.destroy();
  });
  it("deletes the intended old characters after a peer inserts earlier text", () => {
    const f = fixture("One two three");
    f.doc.transact(() => f.text.insert(0, "Go: "), "peer");
    expect(f.edit("One three", "One two three")).toBe("Go: One three");
    f.draft.dispose();
    f.doc.destroy();
  });
  it("uses the latest acknowledged render for consecutive edits and formatting", () => {
    const f = fixture("Ready");
    f.text.format(0, 5, { bold: true });
    expect(f.edit("Ready?", "Ready")).toBe("Ready?");
    f.draft.acknowledge("Ready?");
    expect(f.edit("Ready? Yes", "Ready?")).toBe("Ready? Yes");
    expect(f.text.toDelta()[0].attributes?.bold).toBe(true);
    f.draft.dispose();
    f.doc.destroy();
  });
});
