import * as Y from "yjs";

/** Translate a textarea edit through changes received since its last render. */
export class CollaborativeTextDraft {
  private presented: string;
  private anchors: {
    base: string;
    right: Y.RelativePosition[];
    left: Y.RelativePosition[];
  } | null = null;
  private applying = false;
  private readonly doc: Y.Doc;

  constructor(private readonly text: Y.Text) {
    if (!text.doc) throw new Error("Sticky text must belong to a document");
    this.doc = text.doc;
    this.presented = text.toString();
    this.doc.on("beforeTransaction", this.capture);
  }

  private capture = () => {
    if (
      this.applying ||
      this.anchors ||
      this.presented !== this.text.toString()
    )
      return;
    const offsets = Array.from(
      { length: this.presented.length + 1 },
      (_, index) => index,
    );
    this.anchors = {
      base: this.presented,
      right: offsets.map((index) =>
        Y.createRelativePositionFromTypeIndex(this.text, index, 0),
      ),
      left: offsets.map((index) =>
        Y.createRelativePositionFromTypeIndex(this.text, index, -1),
      ),
    };
  };

  acknowledge(value: string) {
    // A concurrent update can arrive between render and layout effect. Retain
    // the old anchors until the textarea has actually caught up with the model.
    if (value !== this.text.toString()) return;
    this.presented = value;
    this.anchors = null;
  }

  apply(
    value: string,
    previous: string,
    transact: (change: () => void) => void,
  ) {
    let start = 0;
    while (
      start < previous.length &&
      start < value.length &&
      previous[start] === value[start]
    )
      start++;
    let tail = 0;
    while (
      tail < previous.length - start &&
      tail < value.length - start &&
      previous[previous.length - tail - 1] === value[value.length - tail - 1]
    )
      tail++;
    const end = previous.length - tail;
    let from = start,
      to = end;
    if (previous !== this.text.toString()) {
      if (!this.anchors || previous !== this.anchors.base)
        return this.text.toString();
      const resolve = (position: Y.RelativePosition) =>
        Y.createAbsolutePositionFromRelativePosition(position, this.doc);
      const first = resolve(
        end === start ? this.anchors.left[start] : this.anchors.right[start],
      );
      const last = end === start ? first : resolve(this.anchors.left[end]);
      if (
        !first ||
        !last ||
        first.type !== this.text ||
        last.type !== this.text
      )
        return this.text.toString();
      from = first.index;
      to = Math.max(from, last.index);
    }
    this.capture();
    this.applying = true;
    try {
      transact(() => {
        if (to > from) this.text.delete(from, to - from);
        const insertion = value.slice(start, value.length - tail);
        if (insertion) this.text.insert(from, insertion);
      });
    } finally {
      this.applying = false;
    }
    return this.text.toString();
  }

  dispose() {
    this.doc.off("beforeTransaction", this.capture);
  }
}
