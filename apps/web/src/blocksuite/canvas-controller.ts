import * as Y from "yjs";
import { demoPattern, type DemoPatternId } from "./demo-patterns";
import { nativeBlockText } from "./native-block-text";
import { canvasFitPadding } from "./canvas-layout";
import {
  DefaultTool,
  EdgelessCRUDIdentifier,
} from "@blocksuite/affine/blocks/surface";
import { BrushTool, EraserTool } from "@blocksuite/affine/gfx/brush";
import { ConnectorTool } from "@blocksuite/affine/gfx/connector";
import { PanTool } from "@blocksuite/affine/gfx/pointer";
import { ShapeTool, mountShapeTextEditor } from "@blocksuite/affine/gfx/shape";
import { TextTool } from "@blocksuite/affine/gfx/text";
import { createGroupFromSelectedCommand } from "@blocksuite/affine/gfx/group";
import { FrameTool } from "@blocksuite/affine/blocks/frame";
import { addImages } from "@blocksuite/affine/blocks/image";
import {
  duplicate,
  type EdgelessRootBlockComponent,
} from "@blocksuite/affine/blocks/root";
import { Bound } from "@blocksuite/affine/global/gfx";
import {
  ConnectorMode,
  PointStyle,
  NoteDisplayMode,
  StrokeStyle,
  ShapeStyle,
  ShapeType,
  ConnectorElementModel,
  ShapeElementModel,
  getShapeType,
  type ShapeName,
} from "@blocksuite/affine/model";
import { EditPropsStore } from "@blocksuite/affine/shared/services";
import { Text } from "@blocksuite/affine/store";
import {
  BaseTool,
  GfxControllerIdentifier,
  type GfxModel,
} from "@blocksuite/std/gfx";
import type { PointerEventState } from "@blocksuite/affine/std";
import type { WhiteboardEditorElement } from "./editor-container";
import {
  arrangeBoxes,
  findOpenPosition,
  connectedPosition,
  CONNECTION_PORTS,
  type Direction,
  type Arrangement,
} from "./layout";
import { CollaborativeTextDraft } from "./text-draft";
import { canvasPointAt } from "./canvas-hit-test";

export type CanvasTool =
  | "select"
  | "hand"
  | "sticky"
  | "text"
  | "shape"
  | "connector"
  | "pen"
  | "eraser"
  | "frame";
export const STICKY_COLORS = [
  { name: "Yellow", value: "#fff0a6" },
  { name: "Peach", value: "#ffd6b0" },
  { name: "Pink", value: "#ffd2df" },
  { name: "Lilac", value: "#ded6ff" },
  { name: "Blue", value: "#cceaff" },
  { name: "Mint", value: "#d2f2d0" },
];
export type CanvasOptions = {
  color: string;
  shape: ShapeName;
  line: ConnectorMode;
  penColor: string;
  penWidth: 2 | 4 | 6 | 12;
};
export const DEFAULT_OPTIONS: CanvasOptions = {
  color: STICKY_COLORS[0].value,
  shape: "roundedRect",
  line: ConnectorMode.Orthogonal,
  penColor: "#27334b",
  penWidth: 4,
};

// Native blocks remain the source of truth for persistence, history and MCP.
export function createSticky(
  editor: WhiteboardEditorElement,
  x: number,
  y: number,
  color: string,
  content = "",
  size = { w: 208, h: 208 },
) {
  const gfx = editor.std.get(GfxControllerIdentifier);
  const store = editor.doc;
  const id = store.addBlock(
    "affine:note",
    {
      xywh: new Bound(x, y, size.w, size.h).serialize(),
      index: gfx.layer.generateIndex(),
      displayMode: NoteDisplayMode.EdgelessOnly,
      background: { light: color, dark: color },
      edgeless: {
        collapse: true,
        collapsedHeight: size.h,
        scale: 1,
        style: {
          borderRadius: 2,
          borderSize: 0,
          borderStyle: StrokeStyle.None,
          shadowType: "--affine-note-shadow-box",
        },
      },
    },
    store.root!.id,
  );
  const paragraphId = store.addBlock(
    "affine:paragraph",
    { type: "text", text: new Text(content) },
    id,
  );
  return { id, paragraphId };
}

/** Create the native preview only after the pointer enters usable canvas. */
export class CanvasShapeTool extends ShapeTool {
  static override toolName = "whiteboard:shape";
  private awaitingPointer = true;
  override activate() { this.clearOverlay(); this.awaitingPointer = true; }
  override pointerMove(event: PointerEventState) {
    const host = this.std.host.closest<HTMLElement>(".editor-canvas");
    if (!host || !canvasPointAt(host, { x: event.raw.clientX, y: event.raw.clientY })) {
      this.clearOverlay(); this.awaitingPointer = true; return;
    }
    if (this.awaitingPointer) { this.createOverlay(); this.awaitingPointer = false; }
    super.pointerMove(event);
  }
  override pointerOut() { this.clearOverlay(); this.awaitingPointer = true; }
}

export class StickyTool extends BaseTool<{ color: string }> {
  static override toolName = "whiteboard:sticky";
  private dragging = false;
  private preview(event: PointerEventState | null) {
    this.std.host.closest("whiteboard-editor")?.dispatchEvent(
      new CustomEvent("whiteboard-sticky-preview", {
        bubbles: true,
        detail: event
          ? { x: event.x, y: event.y, color: this.activatedOption.color }
          : null,
      }),
    );
  }
  override pointerMove(event: PointerEventState) {
    this.preview(event);
  }
  override pointerOut() {
    if (!this.dragging) this.preview(null);
  }
  override dragStart(event: PointerEventState) {
    this.dragging = true;
    this.preview(event);
  }
  override dragMove(event: PointerEventState) {
    this.preview(event);
  }
  override dragEnd(event: PointerEventState) {
    if (!this.dragging) return;
    this.dragging = false;
    const host = this.std.host.closest<HTMLElement>(".editor-canvas");
    if (
      !host ||
      !canvasPointAt(host, { x: event.raw.clientX, y: event.raw.clientY })
    ) {
      this.preview(null);
      return;
    }
    this.click(event);
  }
  override activate() {
    this.dragging = false;
    this.gfx.cursor$.value = "crosshair";
  }
  override deactivate() {
    this.dragging = false;
    this.preview(null);
    this.gfx.cursor$.value = "default";
  }
  override click(event: PointerEventState) {
    if (this.doc.readonly) return;
    const [x, y] = this.gfx.viewport.toModelCoord(event.x, event.y);
    this.doc.captureSync();
    const editor = this.gfx.std.host.closest(
      "whiteboard-editor",
    ) as WhiteboardEditorElement;
    const note = createSticky(
      editor,
      x - 104,
      y - 104,
      this.activatedOption.color,
    );
    this.doc.captureSync();
    this.gfx.tool.setTool(DefaultTool);
    this.gfx.selection.set({ elements: [note.id] });
    editor.dispatchEvent(
      new CustomEvent("whiteboard-edit-note", {
        bubbles: true,
        detail: { id: note.id },
      }),
    );
  }
}

export type CanvasItem = {
  id: string;
  kind: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  locked: boolean;
  bold: boolean;
  simpleSticky: boolean;
};
export type CanvasState = {
  tool: CanvasTool;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  selection: CanvasItem[];
  items: CanvasItem[];
  editing: (CanvasItem & { draft: string }) | null;
};

export function createCanvasController(editor: WhiteboardEditorElement) {
  const gfx = editor.std.get(GfxControllerIdentifier);
  const store = editor.doc;
  const crud = editor.std.get(EdgelessCRUDIdentifier);
  const canvasHost = editor.closest<HTMLElement>(".editor-canvas") ?? editor;
  const editable = () =>
    editor.isConnected &&
    !store.readonly &&
    !editor.closest<HTMLElement>(".editor-canvas")?.inert;
  let editing: {
    id: string;
    draft: string;
    session: CollaborativeTextDraft;
  } | null = null;
  const clearEditing = () => {
    editing?.session.dispose();
    editing = null;
  };
  let cachedItems: CanvasItem[] | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const item = (model: GfxModel): CanvasItem => {
    const props =
      "props" in model
        ? (model.props as Record<string, unknown>)
        : (model as unknown as Record<string, unknown>);
    const kind =
      "flavour" in model
        ? model.flavour.replace("affine:", "")
        : String(props.type ?? "");
    const textValue =
      kind === "note" && "children" in model
        ? nativeBlockText(model)
        : String(props.text ?? props.title ?? "");
    const bound = model.elementBound;
    const color = props.background ?? props.fillColor;
    const bg =
      color && typeof color === "object"
        ? (color as { light?: string }).light
        : color;
    return {
      id: model.id,
      kind,
      text: textValue,
      x: bound.x,
      y: bound.y,
      w: bound.w,
      h: bound.h,
      color: typeof bg === "string" && bg.startsWith("#") ? bg : "#e5eaf4",
      locked: Boolean(props.lockedBySelf ?? props.locked),
      bold:
        kind === "note" &&
        "children" in model &&
        Boolean(textValue.length) &&
        model.children.every((child) => {
          const text = (child.props as { text?: Text }).text;
          return text?.toDelta().every((part) => part.attributes?.bold);
        }),
      simpleSticky:
        kind === "note" &&
        "children" in model &&
        model.children.length <= 1 &&
        model.children.every((child) => child.flavour === "affine:paragraph") &&
        textValue.length <= 10_000,
    };
  };
  const toolNames: Record<string, CanvasTool> = {
    default: "select",
    pan: "hand",
    "whiteboard:sticky": "sticky",
    "affine:note": "sticky",
    text: "text",
    shape: "shape",
    "whiteboard:shape": "shape",
    connector: "connector",
    brush: "pen",
    eraser: "eraser",
    frame: "frame",
  };
  const notePosition = (x: number, y: number) =>
    findOpenPosition(
      { id: "new", x, y, w: 208, h: 208 },
      gfx.gfxElements
        .map(item)
        .filter(
          (model) => !["frame", "connector", "group"].includes(model.kind),
        ),
    );
  const fit = (ids?: string[]) => {
    const models = ids
      ?.map((id) => gfx.getElementById<GfxModel>(id))
      .filter((model): model is GfxModel => Boolean(model));
    gfx.fitToScreen({
      bounds: models?.map((m) => m.elementBound),
      smooth: true,
      padding: canvasFitPadding(canvasHost),
    });
  };
  const selectTool = (tool: CanvasTool, options: CanvasOptions) => {
    clearEditing();
    if (!editable() && tool !== "select" && tool !== "hand") return;
    switch (tool) {
      case "select":
        gfx.tool.setTool(DefaultTool);
        break;
      case "hand":
        gfx.tool.setTool(PanTool, { panning: true });
        break;
      case "sticky":
        gfx.tool.setTool(StickyTool, { color: options.color });
        break;
      case "text":
        editor.std.get(EditPropsStore).recordLastProps("text", {
          color: { light: "#23304a", dark: "#eef2fb" },
        });
        gfx.tool.setTool(TextTool);
        break;
      case "shape":
        editor.std
          .get(EditPropsStore)
          .recordLastProps(("shape:" + options.shape) as "shape:rect", {
            fillColor: { light: "#ffffff", dark: "#283347" },
            color: { light: "#23304a", dark: "#eef2fb" },
            strokeColor: { light: "#425574", dark: "#b9c5dc" },
            strokeWidth: 2,
            shapeStyle: ShapeStyle.General,
            filled: true,
          });
        gfx.tool.setTool(CanvasShapeTool, { shapeName: options.shape });
        break;
      case "connector":
        editor.std.get(EditPropsStore).recordLastProps("connector", {
          stroke: { light: "#5c6980", dark: "#aab7cf" },
        });
        gfx.tool.setTool(ConnectorTool, { mode: options.line });
        break;
      case "pen":
        editor.std.get(EditPropsStore).recordLastProps("brush", {
          color:
            options.penColor === "#27334b"
              ? { light: "#27334b", dark: "#c2ccdf" }
              : options.penColor,
          lineWidth: options.penWidth,
        });
        gfx.tool.setTool(BrushTool);
        break;
      case "eraser":
        gfx.tool.setTool(EraserTool);
        break;
      case "frame":
        gfx.tool.setTool(FrameTool);
        break;
    }
  };
  const startEditing = (id: string, initial?: string) => {
    const note = gfx.getElementById<GfxModel>(id);
    if (!editable() || !note || item(note).kind !== "note" || item(note).locked)
      return false;
    // Keep document notes and embedded blocks in the native rich editor. The
    // sticky editor owns only a single paragraph, so it never flattens old data.
    if (
      !("children" in note) ||
      item(note).text.length > 10_000 ||
      note.children.length > 1 ||
      note.children.some((child) => child.flavour !== "affine:paragraph")
    )
      return false;
    gfx.tool.setTool(DefaultTool);
    gfx.selection.set({ elements: [id] });
    store.captureSync();
    clearEditing();
    const paragraph =
      note.children[0] ??
      store.getModelById(
        store.addBlock(
          "affine:paragraph",
          { type: "text", text: new Text() },
          note.id,
        ),
      )!;
    editing = {
      id,
      draft: item(note).text,
      session: new CollaborativeTextDraft(
        (paragraph.props as { text: Text }).text.yText,
      ),
    };
    if (initial !== undefined) setEditingText(initial);
    notify();
    return true;
  };
  const setEditingText = (value: string, previous = editing?.draft) => {
    if (!editing || !editable() || previous === undefined) return;
    const note = gfx.getElementById<GfxModel>(editing.id);
    if (!note || item(note).locked) {
      clearEditing();
      notify();
      return;
    }
    editing.draft = editing.session.apply(value, previous, (change) =>
      store.transact(change),
    );
    notify();
  };
  const editShape = (model: GfxModel, initialText?: string) => {
    if (
      !editable() ||
      !(model instanceof ShapeElementModel) ||
      model.isLocked()
    )
      return false;
    const root = editor.std.view.getBlock(store.root!.id);
    if (!root) return false;
    store.captureSync();
    mountShapeTextEditor(model, root);
    if (initialText !== undefined && model.text) {
      store.transact(() => {
        model.text!.delete(0, model.text!.length);
        model.text!.insert(0, initialText);
      });
    }
    return true;
  };
  const addNotes = (texts: string[], color: string) => {
    if (!editable() || !texts.length) return;
    const columns = Math.min(4, Math.ceil(Math.sqrt(texts.length)));
    const existing = gfx.gfxElements.length ? gfx.elementsBound : null;
    const x = existing ? existing.x : gfx.viewport.center.x - columns * 120;
    const y = existing
      ? existing.y + existing.h + 96
      : gfx.viewport.center.y - 104;
    const ids: string[] = [];
    store.captureSync();
    store.transact(() => {
      texts.forEach((text, index) =>
        ids.push(
          createSticky(
            editor,
            x + (index % columns) * 240,
            y + Math.floor(index / columns) * 240,
            color,
            text,
          ).id,
        ),
      );
    });
    store.captureSync();
    gfx.tool.setTool(DefaultTool);
    gfx.selection.set({ elements: ids });
    fit(ids);
    return ids;
  };
  const connectionObstacles = () =>
    gfx.gfxElements
      .map(item)
      .filter((m) => !["frame", "connector", "group"].includes(m.kind));
  const connectionPreview = (
    sourceId: string,
    direction: Direction,
    point?: { x: number; y: number },
  ) => {
    const source = gfx.getElementById<GfxModel>(sourceId);
    if (
      !source ||
      !editable() ||
      item(source).locked ||
      !item(source).simpleSticky
    )
      return null;
    const old = item(source);
    if (point) {
      const [x, y] = gfx.viewport.toModelCoord(point.x, point.y);
      const hit = gfx.getElementByPoint(x, y);
      if (hit?.id === source.id) return null;
      if (
        hit &&
        hit.id !== source.id &&
        ["note", "shape", "text", "image"].includes(item(hit).kind)
      ) {
        return { source: old, target: item(hit), existing: true, direction };
      }
      return {
        source: old,
        target: {
          ...old,
          id: "new",
          x: x - old.w / 2,
          y: y - old.h / 2,
          text: "",
        },
        existing: false,
        direction,
      };
    }
    const position = connectedPosition(old, direction, connectionObstacles());
    return {
      source: old,
      target: { ...old, ...position, text: "" },
      existing: false,
      direction,
    };
  };
  const connectNext = (
    direction: Direction,
    sourceId = gfx.selection.selectedElements[0]?.id,
    point?: { x: number; y: number },
  ) => {
    if (!sourceId) return;
    const preview = connectionPreview(sourceId, direction, point);
    if (!preview) return;
    const { source, target, existing } = preview;
    const sourceModel = gfx.getElementById<GfxModel>(sourceId)!;
    const ports = CONNECTION_PORTS[direction];
    let nextId = target.id;
    store.captureSync();
    store.transact(() => {
      if (!existing) {
        nextId = createSticky(
          editor,
          target.x,
          target.y,
          source.color,
          "",
          source,
        ).id;
        // Preserve native note scale, borders and shadow, without copying text.
        if ("props" in sourceModel) {
          const props = sourceModel.props as {
            background?: unknown;
            edgeless?: Record<string, unknown>;
          };
          const style = props.edgeless;
          const scale =
            typeof style?.scale === "number" && style.scale > 0
              ? style.scale
              : 1;
          crud.updateElement(nextId, {
            ...(props.background ? { background: props.background } : {}),
            ...(style
              ? { edgeless: { ...style, collapsedHeight: target.h / scale } }
              : {}),
          });
        }
      }
      crud.addElement("connector", {
        mode: ConnectorMode.Orthogonal,
        strokeWidth: 2,
        stroke: { light: "#5c6980", dark: "#aab7cf" },
        frontEndpointStyle: PointStyle.None,
        rearEndpointStyle: PointStyle.Arrow,
        source: { id: sourceId, position: ports.source },
        target: existing
          ? { id: nextId }
          : { id: nextId, position: ports.target },
      });
    });
    store.captureSync();
    gfx.tool.setTool(DefaultTool);
    gfx.selection.set({ elements: [nextId] });
    // Preserve the user's zoom unless the new note falls outside the viewport.
    const bounds = gfx.viewport.toViewCoord(target.x, target.y);
    if (
      !existing &&
      (bounds[0] < 88 ||
        bounds[1] < 80 ||
        bounds[0] + target.w * gfx.viewport.zoom >
          canvasHost.clientWidth - 40 ||
        bounds[1] + target.h * gfx.viewport.zoom > canvasHost.clientHeight - 80)
    )
      fit([sourceId, nextId]);
    if (!existing) startEditing(nextId);
  };
  return {
    editable,
    connectionPreview,
    toViewBox(box: { x: number; y: number; w: number; h: number }) {
      const [x, y] = gfx.viewport.toViewCoord(box.x, box.y);
      return {
        x,
        y,
        w: box.w * gfx.viewport.zoom,
        h: box.h * gfx.viewport.zoom,
      };
    },
    placeTool(
      tool: "sticky" | "shape",
      x: number,
      y: number,
      options: CanvasOptions,
    ) {
      if (!editable()) return;
      clearEditing();
      const [mx, my] = gfx.viewport.toModelCoord(x, y);
      store.captureSync();
      let id: string;
      if (tool === "sticky")
        id = createSticky(editor, mx - 104, my - 104, options.color).id;
      else {
        const shapeId = crud.addElement("shape", {
          shapeType: getShapeType(options.shape),
          radius: options.shape === "roundedRect" ? 0.1 : 0,
          xywh: new Bound(mx - 100, my - 64, 200, 128).serialize(),
          fillColor: { light: "#ffffff", dark: "#283347" },
          color: { light: "#23304a", dark: "#eef2fb" },
          strokeColor: { light: "#425574", dark: "#b9c5dc" },
          strokeWidth: 2,
          shapeStyle: ShapeStyle.General,
          filled: true,
        });
        if (!shapeId) return;
        id = shapeId;
      }
      store.captureSync();
      gfx.tool.setTool(DefaultTool);
      gfx.selection.set({ elements: [id] });
      if (tool === "sticky") startEditing(id);
      else notify();
    },
    isEditing: () => Boolean(editing) || gfx.selection.editing,
    startEditing,
    setEditingText,
    acknowledgeEditingText(id: string, value: string) {
      if (editing?.id === id) editing.session.acknowledge(value);
    },
    finishEditing(id?: string) {
      if (id && editing?.id !== id) return;
      clearEditing();
      store.captureSync();
      notify();
    },
    gridStyle() {
      let spacing = 24 * gfx.viewport.zoom;
      while (spacing < 14) spacing *= 2;
      while (spacing > 48) spacing /= 2;
      const [x, y] = gfx.viewport.toViewCoord(0, 0);
      return { spacing, x: x % spacing, y: y % spacing };
    },
    addAdjacentNote() {
      if (!editing || !editable()) return;
      const source = gfx.getElementById<GfxModel>(editing.id);
      if (!source) return;
      const old = item(source);
      const position = notePosition(old.x + old.w + 32, old.y);
      store.captureSync();
      const next = createSticky(editor, position.x, position.y, old.color);
      store.captureSync();
      startEditing(next.id);
      fit([source.id, next.id]);
    },
    editNoteAtPoint(x: number, y: number) {
      const [mx, my] = gfx.viewport.toModelCoord(x, y);
      const note = gfx.getElementByPoint(mx, my);
      return note ? startEditing(note.id) || editShape(note) : false;
    },
    editSelectedShape(initialText?: string) {
      const selected = gfx.selection.selectedElements;
      return selected.length === 1
        ? editShape(selected[0], initialText)
        : false;
    },
    viewBounds(id: string) {
      const model = gfx.getElementById<GfxModel>(id);
      if (!model) return null;
      const bounds = model.elementBound;
      const [x, y] = gfx.viewport.toViewCoord(bounds.x, bounds.y);
      return {
        x,
        y,
        w: bounds.w * gfx.viewport.zoom,
        h: bounds.h * gfx.viewport.zoom,
      };
    },
    editSelectedNote(value?: string, replace = false) {
      if (!editable()) return false;
      if (editing) {
        if (value) setEditingText(editing.draft + value);
        return true;
      }
      const note = gfx.selection.selectedElements[0];
      if (
        !note ||
        item(note).kind !== "note" ||
        item(note).locked ||
        !("children" in note)
      )
        return false;
      return startEditing(
        note.id,
        replace && value !== undefined ? value : undefined,
      );
    },
    state(): CanvasState {
      const editingModel = editing && gfx.getElementById<GfxModel>(editing.id);
      if (!editingModel || !editable()) clearEditing();
      cachedItems ??= gfx.gfxElements.map(item);
      return {
        tool: toolNames[gfx.tool.currentToolName$.peek() ?? ""] ?? "select",
        zoom: gfx.viewport.zoom,
        canUndo: store.canUndo,
        canRedo: store.canRedo,
        selection: gfx.selection.selectedElements.map(item),
        items: cachedItems,
        editing:
          editing && editingModel
            ? { ...item(editingModel), draft: editing.draft }
            : null,
      };
    },
    subscribe(onChange: () => void) {
      listeners.add(onChange);
      let frame = 0;
      let refreshDraft = false;
      const schedule = () => {
        if (!frame)
          frame = requestAnimationFrame(() => {
            frame = 0;
            if (refreshDraft && editing) {
              const model = gfx.getElementById<GfxModel>(editing.id);
              if (model) editing.draft = item(model).text;
            }
            refreshDraft = false;
            onChange();
          });
      };
      const a = gfx.viewport.viewportUpdated.subscribe(schedule);
      const b = gfx.selection.slots.updated.subscribe(() => {
        if (editing && !gfx.selection.selectedIds.includes(editing.id))
          clearEditing();
        schedule();
      });
      const c = gfx.tool.currentToolName$.subscribe(schedule);
      const d = store.slots.blockUpdated.subscribe(() => {
        cachedItems = null;
        schedule();
      });
      const history = store.history.onUpdated.subscribe(schedule);
      const readonly = store.readonly$.subscribe(schedule);
      const doc = store.spaceDoc;
      const beginEditing = (event: Event) =>
        startEditing((event as CustomEvent<{ id: string }>).detail.id);
      // Paste followed immediately by Escape can beat the native label's
      // ResizeObserver. Flush its actual DOM size before the editor commits
      // its stashed bounds, so the persisted label never keeps its empty size.
      const commitConnectorLabel = (event: Event) => {
        if (!editable() || !(event.target instanceof Element)) return;
        const label = event.target.closest(".edgeless-connector-label-editor");
        const inline = label?.querySelector<HTMLElement>(".inline-editor");
        const connector = label?.closest<
          HTMLElement & { connector?: ConnectorElementModel }
        >("edgeless-connector-label-editor")?.connector;
        if (
          !inline ||
          !(connector instanceof ConnectorElementModel) ||
          !connector.text?.length
        )
          return;
        const bounds = Bound.fromCenter(
          connector.getPointByOffsetDistance(connector.labelOffset.distance),
          inline.scrollWidth,
          inline.scrollHeight,
        );
        editor.std.get(EdgelessCRUDIdentifier).updateElement(connector.id, {
          labelXYWH: bounds.toXYWH(),
        });
      };
      const documentUpdated = (_update: Uint8Array, origin: unknown) => {
        cachedItems = null;
        if (origin === "native-remote" || origin === store.history.undoManager)
          refreshDraft = true;
        schedule();
      };
      editor.addEventListener("whiteboard-edit-note", beginEditing);
      editor.addEventListener("blur", commitConnectorLabel, true);
      doc.on("update", documentUpdated);
      return () => {
        clearEditing();
        listeners.delete(onChange);
        cancelAnimationFrame(frame);
        a.unsubscribe();
        b.unsubscribe();
        c();
        d.unsubscribe();
        history.unsubscribe();
        readonly();
        doc.off("update", documentUpdated);
        editor.removeEventListener("whiteboard-edit-note", beginEditing);
        editor.removeEventListener("blur", commitConnectorLabel, true);
      };
    },
    selectTool,
    addNotes,
    connectNext,
    fit,
    zoom(value: number) {
      gfx.viewport.setZoom(value);
    },
    undo() {
      if (editable()) store.undo();
    },
    redo() {
      if (editable()) store.redo();
    },
    async uploadImage(file: File) {
      if (!editable()) return;
      if (!file.type.startsWith("image/"))
        throw new Error("Choose an image file.");
      if (file.size > 20 * 1024 * 1024)
        throw new Error("Choose an image smaller than 20 MB.");
      const existing = gfx.gfxElements.length ? gfx.elementsBound : null;
      store.captureSync();
      const ids = await addImages(editor.std, [file], { maxWidth: 800 });
      if (!editable()) return;
      if (existing)
        store.transact(() =>
          ids.forEach((id) => {
            const model = gfx.getElementById<GfxModel>(id);
            if (model)
              crud.updateElement(id, {
                xywh: new Bound(
                  existing.x,
                  existing.y + existing.h + 96,
                  model.elementBound.w,
                  model.elementBound.h,
                ).serialize(),
              });
          }),
        );
      store.captureSync();
      if (ids.length) fit(ids);
    },
    select(id: string) {
      gfx.tool.setTool(DefaultTool);
      gfx.selection.set({ elements: [id] });
      fit([id]);
    },
    colorSelection(color: string) {
      if (!editable()) return;
      store.captureSync();
      store.transact(() =>
        gfx.selection.selectedElements.forEach((model) => {
          if (item(model).kind === "note" && !item(model).locked)
            crud.updateElement(model.id, {
              background: { light: color, dark: color },
            });
        }),
      );
      store.captureSync();
    },
    async duplicateSelection() {
      if (!editable()) return;
      const root = editor.std.view.getBlock(
        store.root!.id,
      ) as EdgelessRootBlockComponent | null;
      if (root) await duplicate(root, gfx.selection.selectedElements);
    },
    lockSelection() {
      if (!editable()) return;
      const notes = gfx.selection.selectedElements.filter(
        (model) => item(model).kind === "note",
      );
      const lock = notes.some((model) => !item(model).locked);
      store.captureSync();
      store.transact(() =>
        notes.forEach((model) =>
          crud.updateElement(model.id, { lockedBySelf: lock }),
        ),
      );
      store.captureSync();
    },
    boldSelection() {
      if (!editable()) return;
      const notes = gfx.selection.selectedElements.filter(
        (model) => item(model).kind === "note" && !item(model).locked,
      );
      const bold = !notes.every((model) => item(model).bold);
      store.captureSync();
      store.transact(() =>
        notes.forEach((model) => {
          if (
            item(model).kind !== "note" ||
            item(model).locked ||
            !("children" in model)
          )
            return;
          for (const child of model.children) {
            const text = (child.props as { text?: Text }).text;
            if (!text) continue;
            text.format(0, text.length, { bold });
          }
        }),
      );
      store.captureSync();
    },
    arrange(action: Arrangement) {
      if (!editable()) return;
      const selected = gfx.selection.selectedElements.filter(
        (model) =>
          !item(model).locked &&
          !["connector", "frame", "group", "mindmap"].includes(
            item(model).kind,
          ) &&
          !model.group,
      );
      const boxes = arrangeBoxes(selected.map(item), action);
      store.captureSync();
      store.transact(() =>
        boxes.forEach((box) =>
          crud.updateElement(box.id, {
            xywh: new Bound(box.x, box.y, box.w, box.h).serialize(),
          }),
        ),
      );
      store.captureSync();
    },
    groupSelection() {
      if (
        !editable() ||
        gfx.selection.selectedElements.some((model) => item(model).locked)
      )
        return;
      store.captureSync();
      editor.std.command.exec(createGroupFromSelectedCommand);
      store.captureSync();
    },
    insertTemplate(kind: "brainstorm" | "retro" | "kanban" | "flow" | DemoPatternId) {
      if (!editable() || !gfx.surface) return;
      const existing = gfx.elementsBound;
      const x = existing
        ? existing.x + existing.w + 180
        : gfx.viewport.center.x - 600;
      const y = existing ? existing.y : gfx.viewport.center.y - 340;
      if (kind === "update-flow" || kind === "fifty-notes") {
        const pattern = demoPattern(kind);
        const ids: string[] = [];
        const nativeIds = new Map<string, string>();
        store.captureSync();
        store.transact(() => {
          for (const node of pattern.nodes) {
            const bounds = new Bound(x + node.x, y + node.y, node.w, node.h);
            const id = node.kind === "sticky"
              ? createSticky(editor, bounds.x, bounds.y, node.color, node.text, { w: node.w, h: node.h }).id
              : crud.addElement("shape", {
                shapeType: node.shape === "diamond" ? ShapeType.Diamond : getShapeType("roundedRect"),
                radius: node.shape === "diamond" ? 0 : 0.1,
                xywh: bounds.serialize(), text: new Y.Text(node.text),
                fillColor: { light: node.color, dark: node.color },
                color: { light: "#23304a", dark: "#23304a" },
                strokeColor: { light: "#425574", dark: "#425574" },
                strokeWidth: 1.5, shapeStyle: ShapeStyle.General, filled: true,
                fontFamily: "blocksuite:surface:Inter", fontSize: 20,
                textHorizontalAlign: "center", textVerticalAlign: "center",
                textResizing: 1, padding: [16, 18],
              });
            if (id) { nativeIds.set(node.id, id); ids.push(id); }
          }
          for (const frame of pattern.frames) {
            const id = store.addBlock("affine:frame", {
              title: new Text(frame.title),
              xywh: new Bound(x + frame.x, y + frame.y, frame.w, frame.h).serialize(),
              background: "transparent", index: gfx.layer.generateIndex(),
              childElementIds: Object.fromEntries(frame.children.flatMap(key => {
                const id = nativeIds.get(key); return id ? [[id, true]] : [];
              })),
            }, gfx.surface!.id);
            ids.push(id);
          }
          for (const edge of pattern.edges) {
            const source = nativeIds.get(edge.source), target = nativeIds.get(edge.target);
            if (!source || !target) continue;
            const id = crud.addElement("connector", {
              mode: ConnectorMode.Orthogonal, strokeWidth: 2,
              stroke: { light: "#5c6980", dark: "#aab7cf" },
              source: { id: source, position: edge.sourcePort },
              target: { id: target, position: edge.targetPort },
              rearEndpointStyle: PointStyle.Arrow,
            });
            if (id) ids.push(id);
          }
        });
        // Native label/frame layout settles on the next paint. Keep those
        // normalization updates in this insertion's undo group. Subsequent
        // authoring actions capture their own boundary before changing data.
        gfx.tool.setTool(DefaultTool);
        gfx.selection.set({ elements: [] });
        // Connector paths initialize during rendering. Fitting immediately
        // includes their temporary origin bounds on a populated board.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (editor.isConnected) fit(ids);
        }));
        return ids;
      }
      const titles =
        kind === "retro"
          ? ["Went well", "Could be better", "Next steps"]
          : kind === "kanban"
            ? ["To do", "In progress", "Done"]
            : kind === "brainstorm"
              ? ["Ideas", "Explore", "Decide"]
              : ["Start", "Review", "Decide", "Deliver"];
      const ids: string[] = [];
      const notes: string[] = [];
      store.captureSync();
      store.transact(() => {
        titles.forEach((title, column) => {
          const nx = x + column * 304;
          const children: Record<string, boolean> = {};
          const count = kind === "flow" ? 1 : 3;
          for (let row = 0; row < count; row++) {
            const note = createSticky(
              editor,
              nx + 24,
              y + 64 + row * 240,
              STICKY_COLORS[column % STICKY_COLORS.length].value,
              kind === "flow" ? title : "",
            );
            children[note.id] = true;
            notes.push(note.id);
            ids.push(note.id);
          }
          if (kind !== "flow") {
            const id = store.addBlock(
              "affine:frame",
              {
                title: new Text(title),
                xywh: new Bound(nx, y, 272, 800).serialize(),
                background: "#ffffff",
                index: gfx.layer.generateIndex(),
                childElementIds: children,
              },
              gfx.surface!.id,
            );
            ids.push(id);
          }
        });
        if (kind === "flow")
          notes.slice(1).forEach((id, i) => {
            const connector = crud.addElement("connector", {
              mode: ConnectorMode.Orthogonal,
              strokeWidth: 2,
              stroke: "#5c6980",
              source: { id: notes[i], position: [1, 0.5] },
              target: { id, position: [0, 0.5] },
              rearEndpointStyle: PointStyle.Arrow,
            });
            if (connector) ids.push(connector);
          });
      });
      store.captureSync();
      gfx.tool.setTool(DefaultTool);
      gfx.selection.set({ elements: [] });
      fit(ids);
      return ids;
    },
  };
}
export type CanvasController = ReturnType<typeof createCanvasController>;
