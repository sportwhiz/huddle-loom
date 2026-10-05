import { DEMO_PATTERNS } from "./demo-patterns";
import { PatternPreview } from "./PatternPreview";
import { openTour } from "../onboarding-events";
import { UiIcon } from "../UiIcon";
import { canvasPointAt } from "./canvas-hit-test";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ConnectorMode,
  ShapeType,
  type ShapeName,
} from "@blocksuite/affine/model";
import {
  STICKY_COLORS,
  TEXT_MARKS,
  type TextMark,
  type CanvasController,
  type CanvasOptions,
  type CanvasState,
  type CanvasTool,
} from "./canvas-controller";
import { CONNECTION_PORTS, type Direction, type Arrangement } from "./layout";
import { usePointerDrag, type DragPoint } from "./pointer-drag";
import { loadToolPreferences, saveToolPreferences } from "./tool-preferences";
import {
  STICKY_ALIGNMENTS,
  STICKY_FONTS,
  STICKY_SIZES,
  STICKY_TEXT_COLORS,
  stickyFontCss,
  stickySizePx,
  stickyTextCss,
  type StickyAlign,
  type StickyTextStyle,
} from "./sticky-text-style";
import {
  createStickyInlineEditor,
  IS_MAC,
  MARK_SHORTCUTS,
  markForShortcut,
  pastedStickyText,
  type StickyInlineEditor,
} from "./sticky-rich-text";
import "./canvas-chrome.css";

const ALIGN_ICONS: Record<StickyAlign, IconName> = {
  left: "alignLeft",
  center: "alignCenter",
  right: "alignRight",
};
const shortcutLabel = (mark: TextMark) =>
  (IS_MAC ? "⌘" : "Ctrl+") +
  (MARK_SHORTCUTS[mark].shift ? (IS_MAC ? "⇧" : "Shift+") : "") +
  MARK_SHORTCUTS[mark].key.toUpperCase();

type IconName =
  | CanvasTool
  | "templates"
  | "upload"
  | "undo"
  | "redo"
  | "search"
  | "fit"
  | "minus"
  | "plus"
  | "close"
  | "help"
  | "map"
  | "arrange"
  | "arrow"
  | "grid"
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "textColor"
  | "alignLeft"
  | "alignCenter"
  | "alignRight"
  | "lock"
  | "duplicate";
function Icon({ name }: { name: IconName }) {
  return <UiIcon name={name} className="canvas-icon" />;
}
const TOOLS: { id: CanvasTool; label: string; key: string }[] = [
  { id: "select", label: "Select", key: "V" },
  { id: "hand", label: "Hand", key: "H" },
  { id: "sticky", label: "Sticky note", key: "N" },
  { id: "text", label: "Text", key: "T" },
  { id: "shape", label: "Shapes", key: "S" },
  { id: "connector", label: "Connection line", key: "L" },
  { id: "pen", label: "Pen", key: "P" },
  { id: "frame", label: "Frame", key: "F" },
];
const SHAPES: { id: ShapeName; label: string; content: ReactNode }[] = [
  {
    id: "roundedRect",
    label: "Rounded rectangle",
    content: <rect x="4" y="6" width="24" height="20" rx="5" />,
  },
  {
    id: ShapeType.Rect,
    label: "Rectangle",
    content: <rect x="4" y="6" width="24" height="20" />,
  },
  {
    id: ShapeType.Ellipse,
    label: "Ellipse",
    content: <ellipse cx="16" cy="16" rx="12" ry="10" />,
  },
  {
    id: ShapeType.Diamond,
    label: "Decision",
    content: <path d="m16 3 13 13-13 13L3 16Z" />,
  },
  {
    id: ShapeType.Triangle,
    label: "Triangle",
    content: <path d="m16 4 13 24H3Z" />,
  },
];
function Palette({
  color,
  onChange,
  disabled = false,
  onDragStart,
  consumeClick,
}: {
  onDragStart?: (
    event: ReactPointerEvent<HTMLButtonElement>,
    color: string,
  ) => void;
  consumeClick?: () => boolean;
  color: string;
  onChange: (color: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="sticky-swatches" aria-label="Sticky note colors">
      {STICKY_COLORS.map((c) => (
        <button
          type="button"
          key={c.value}
          disabled={disabled}
          aria-label={c.name + " sticky note"}
          aria-pressed={color === c.value}
          title={c.name}
          style={{ background: c.value }}
          onPointerDown={(event) => onDragStart?.(event, c.value)}
          onClick={() => {
            if (!consumeClick?.()) onChange(c.value);
          }}
        />
      ))}
    </div>
  );
}
function ConnectionPreview({
  preview,
  controller,
}: {
  preview: NonNullable<ReturnType<CanvasController["connectionPreview"]>>;
  controller: CanvasController;
}) {
  const source = controller.toViewBox(preview.source);
  const target = controller.toViewBox(preview.target);
  const ports = CONNECTION_PORTS[preview.direction];
  const sx = source.x + source.w * ports.source[0],
    sy = source.y + source.h * ports.source[1];
  const tx = target.x + target.w * ports.target[0],
    ty = target.y + target.h * ports.target[1];
  const horizontal =
    preview.direction === "left" || preview.direction === "right";
  const d = horizontal
    ? `M${sx} ${sy} H${(sx + tx) / 2} V${ty} H${tx}`
    : `M${sx} ${sy} V${(sy + ty) / 2} H${tx} V${ty}`;
  return (
    <div className="connection-preview" aria-hidden="true">
      <svg>
        <path d={d} />
      </svg>
      <div
        className={
          preview.existing ? "connection-target existing" : "connection-target"
        }
        style={{
          left: target.x,
          top: target.y,
          width: target.w,
          height: target.h,
          background: preview.existing ? undefined : preview.target.color,
        }}
      />
    </div>
  );
}
function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    (
      dialog?.querySelector<HTMLElement>("textarea, input") ??
      dialog?.querySelector<HTMLElement>("button")
    )?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key !== "Tab" || !dialog) return;
      const controls = [
        ...dialog.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input, textarea, a[href], select",
        ),
      ];
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    dialog?.addEventListener("keydown", key);
    return () => {
      dialog?.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="canvas-modal-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={"canvas-modal" + (wide ? " wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button
            className="canvas-icon-button"
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function CanvasChrome({
  controller,
  host,
  onComment,
  canComment,
}: {
  controller: CanvasController;
  host: HTMLElement;
  onComment: () => void;
  canComment: boolean;
}) {
  const [state, setState] = useState<CanvasState>(() => controller.state());
  const [options, setOptions] = useState<CanvasOptions>(loadToolPreferences);
  const [palette, setPalette] = useState<CanvasTool | null>(null);
  const [modal, setModal] = useState<"bulk" | "templates" | "help" | null>(
    null,
  );
  const [bulk, setBulk] = useState("");
  const [navigation, setNavigation] = useState<
    "search" | "frames" | "map" | null
  >(null);
  const [query, setQuery] = useState("");
  const [zoomMenu, setZoomMenu] = useState(false);
  // The rich editor of the note being edited, and its last text selection,
  // which survives focus moving to a toolbar menu.
  const inlineRef = useRef<StickyInlineEditor | null>(null);
  const lastRange = useRef<{ index: number; length: number } | null>(null);
  const rangeSubscription = useRef<{ unsubscribe(): void } | null>(null);
  const [, setInlineVersion] = useState(0);
  const [textMenu, setTextMenu] = useState<"textColor" | "align" | null>(null);
  const stickyBarRef = useRef<HTMLDivElement>(null);
  const [stickyBarWidth, setStickyBarWidth] = useState(560);
  const [arranging, setArranging] = useState(false);
  const [grid, setGrid] = useState(true);
  const [notice, setNotice] = useState("");
  const chromeRef = useRef<HTMLDivElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [placement, setPlacement] = useState<{
    tool: "sticky" | "shape";
    x: number;
    y: number;
    options: CanvasOptions;
  } | null>(null);
  const [connectionPreview, setConnectionPreview] =
    useState<ReturnType<CanvasController["connectionPreview"]>>(null);
  const dragIntent = useRef<
    | { tool: "sticky" | "shape"; options: CanvasOptions }
    | { source: string; direction: Direction }
    | null
  >(null);
  const canvasPoint = (point: DragPoint) => canvasPointAt(host, point);
  const drag = usePointerDrag({
    preview(point) {
      const local = point && canvasPoint(point);
      const intent = dragIntent.current;
      if (!local || !intent || !controller.editable()) {
        setPlacement(null);
        setConnectionPreview(null);
        return;
      }
      setPalette(null);
      if ("tool" in intent) setPlacement({ ...intent, ...local });
      else
        setConnectionPreview(
          controller.connectionPreview(intent.source, intent.direction, local),
        );
    },
    drop(point) {
      const local = canvasPoint(point);
      const intent = dragIntent.current;
      dragIntent.current = null;
      if (!local || !intent || !controller.editable()) return;
      if ("tool" in intent)
        controller.placeTool(intent.tool, local.x, local.y, intent.options);
      else controller.connectNext(intent.direction, intent.source, local);
      host.focus({ preventScroll: true });
    },
  });
  useEffect(() => {
    saveToolPreferences(options);
  }, [options]);
  useEffect(() => {
    const preview = (event: Event) => {
      const point = (
        event as CustomEvent<{ x: number; y: number; color: string } | null>
      ).detail;
      setPlacement(
        point
          ? {
              tool: "sticky",
              x: point.x,
              y: point.y,
              options: { ...optionsRef.current, color: point.color },
            }
          : null,
      );
    };
    host.addEventListener("whiteboard-sticky-preview", preview);
    return () => host.removeEventListener("whiteboard-sticky-preview", preview);
  }, [host]);
  useEffect(() => {
    setConnectionPreview(null);
  }, [state.selection[0]?.id]);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(
    () => controller.subscribe(() => setState(controller.state())),
    [controller],
  );
  useEffect(() => {
    // Wrap native controls without clipping their popovers. The product owns
    // sticky connector handles, so hide the engine's duplicate handles there.
    const toolbarStyle = document.createElement("style");
    toolbarStyle.textContent = "editor-toolbar { max-width: calc(100vw - 32px); height: auto; min-height: 38px; align-items: center; flex-wrap: wrap; overflow: visible; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); } editor-toolbar > * { flex-shrink: 0; } editor-menu-action[data-testid=\"create-linked-doc\"] { display: none; }";
    const selectionStyle = document.createElement("style");
    selectionStyle.textContent = ":host-context(.whiteboard-note-selection) edgeless-auto-complete { display: none !important; }";
    const attach = () => {
      const toolbar = host.querySelector("affine-toolbar-widget")?.shadowRoot;
      const selection = host.querySelector("edgeless-selected-rect")?.shadowRoot;
      if (toolbar && !toolbarStyle.isConnected) toolbar.append(toolbarStyle);
      if (selection && !selectionStyle.isConnected) selection.append(selectionStyle);
    };
    let frame = 0;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(attach); };
    const observer = new MutationObserver(schedule);
    observer.observe(host, { childList: true, subtree: true });
    const closeOtherMenus = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail !== true) return;
      const path = new Set(event.composedPath());
      const toolbar = host.querySelector("affine-toolbar-widget")?.shadowRoot;
      if (!toolbar) return;
      const visit = (root: ShadowRoot) => {
        for (const element of root.querySelectorAll<HTMLElement>("*")) {
          if (element.localName === "editor-menu-button" && element.dataset.open && !path.has(element)) {
            (element as HTMLElement & { hide(): void }).hide();
          }
          if (element.shadowRoot) visit(element.shadowRoot);
        }
      };
      visit(toolbar);
    };
    host.addEventListener("toggle", closeOtherMenus, true);
    schedule();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); host.removeEventListener("toggle", closeOtherMenus, true); toolbarStyle.remove(); selectionStyle.remove(); };
  }, [host]);
  useEffect(() => {
    const doubleClick = (event: MouseEvent) => {
      const point = canvasPointAt(host, {
        x: event.clientX,
        y: event.clientY,
      });
      if (!point) return;
      if (
        controller.editNoteAtPoint(point.x, point.y)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    host.addEventListener("dblclick", doubleClick, true);
    return () => host.removeEventListener("dblclick", doubleClick, true);
  }, [controller, host]);
  useEffect(() => {
    host.classList.toggle("canvas-grid", grid);
    return () => host.classList.remove("canvas-grid");
  }, [host, grid]);
  useEffect(() => {
    const { spacing, x, y } = controller.gridStyle();
    host.style.setProperty("--grid-spacing", spacing + "px");
    host.style.setProperty("--grid-position", x + "px " + y + "px");
  }, [host, state, controller]);
  const useTool = (tool: CanvasTool, updated = optionsRef.current) => {
    controller.selectTool(tool, updated);
    setPalette(null);
    setNavigation(null);
    setArranging(false);
    setZoomMenu(false);
    host.focus({ preventScroll: true });
  };
  const changeOptions = (patch: Partial<CanvasOptions>) => {
    const next = { ...optionsRef.current, ...patch };
    setOptions(next);
    if (palette) controller.selectTool(palette, next);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const path = event.composedPath();
      // Toolbar controls own Enter/Space, but Escape cancels placement even
      // while a rail button still has focus.
      if (
        event.key === "Escape" &&
        !modal &&
        path.some(
          (target) =>
            target instanceof Element &&
            target.matches(
              ".creation-rail, .tool-palette, .canvas-zoom, .canvas-navigator",
            ),
        ) &&
        !path.some(
          (target) =>
            target instanceof Element &&
            target.matches('input, textarea, select, [contenteditable="true"]'),
        )
      ) {
        drag.cancel();
        dragIntent.current = null;
        event.preventDefault();
        event.stopImmediatePropagation();
        setPalette(null);
        setNavigation(null);
        setZoomMenu(false);
        setArranging(false);
        if (!controller.isEditing())
          controller.selectTool("select", optionsRef.current);
        host.focus({ preventScroll: true });
        return;
      }
      if (
        path.some(
          (target) =>
            target instanceof Element &&
            (target.matches(
              'input, textarea, select, button, a[href], summary, [role="button"], [role="menuitem"], [role="checkbox"], [role="tab"], [contenteditable="true"]',
            ) ||
              target.closest('[role="dialog"]')),
        )
      )
        return;
      // Board panels and app controls own their typing and key handling.
      const target = event.target as HTMLElement;
      if (
        target.closest(
          ".collaboration-panel, .app-header, .history-panel, .share-dialog",
        )
      )
        return;
      if (modal) return;
      const letter = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && letter === "f") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setNavigation("search");
        setPalette(null);
        return;
      }
      const shortcutMark = markForShortcut(event);
      if (shortcutMark && !controller.isEditing()) {
        const selection = controller.state().selection;
        if (
          selection.some((item) => item.simpleSticky) &&
          selection.every((item) => item.simpleSticky || item.kind === "connector")
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          controller.toggleTextMark(shortcutMark);
          return;
        }
      }
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (event.shiftKey && letter === "l")
      )
        return;
      if (
        ((event.key.length === 1 && event.key !== " ") ||
          event.key === "Enter") &&
        controller.state().selection.length === 1 &&
        controller.editSelectedNote(
          event.key === "Enter" ? undefined : event.key,
          !controller.isEditing(),
        )
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPalette(null);
        return;
      }
      if (
        (event.key === "Enter" ||
          (event.key.length === 1 && event.key !== " ")) &&
        !controller.isEditing() &&
        controller.editSelectedShape(
          event.key === "Enter" ? undefined : event.key,
        )
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPalette(null);
        return;
      }
      if (controller.isEditing() && event.key !== "Escape") return;
      if (event.shiftKey && event.key !== "?") return;
      if (
        controller.state().selection.length === 1 &&
        controller.state().selection[0].kind === "note" &&
        !controller.state().selection[0].simpleSticky &&
        (event.key.length === 1 || event.key === "Enter")
      )
        return;
      const tools: Record<string, CanvasTool> = {
        v: "select",
        h: "hand",
        n: "sticky",
        t: "text",
        s: "shape",
        r: "shape",
        o: "shape",
        l: "connector",
        p: "pen",
        e: "eraser",
        f: "frame",
      };
      if (tools[letter]) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const next =
          letter === "r"
            ? { ...optionsRef.current, shape: "rect" as ShapeName }
            : letter === "o"
              ? { ...optionsRef.current, shape: "ellipse" as ShapeName }
              : optionsRef.current;
        setOptions(next);
        useTool(tools[letter], next);
      } else if (event.key === "?" || event.key === "F1") {
        event.preventDefault();
        setModal("help");
      } else if (event.key === "Escape") {
        drag.cancel();
        dragIntent.current = null;
        setPalette(null);
        setNavigation(null);
        setZoomMenu(false);
        setArranging(false);
        if (!controller.isEditing())
          controller.selectTool("select", optionsRef.current);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [controller, modal, host]);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (chromeRef.current?.contains(event.target as Node)) return;
      setPalette(null);
      setZoomMenu(false);
      setArranging(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const editable = controller.editable();
  useEffect(() => {
    if (!editable) {
      drag.cancel();
      setPlacement(null);
      setConnectionPreview(null);
      setPalette(null);
      setModal((current) => (current === "help" ? current : null));
    }
  }, [editable]);
  const lines = bulk
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 100);
  const matches = query.trim()
    ? state.items.filter((item) =>
        item.text.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : [];
  const frames = state.items.filter((item) => item.kind === "frame");
  const stickySelection = state.selection.filter((item) => item.simpleSticky);
  // A box selection also picks up the arrows between notes, so notes plus
  // connectors still get the note toolbar. Its actions apply to the notes.
  const noteSelection =
    stickySelection.length > 0 &&
    state.selection.every(
      (item) => item.simpleSticky || item.kind === "connector",
    );
  const stickyBounds = noteSelection
    ? stickySelection
        .map((note) => controller.viewBounds(note.id))
        .reduce<{ x: number; y: number; w: number; h: number } | null>(
          (union, next) => {
            if (!next) return union;
            if (!union) return next;
            const x = Math.min(union.x, next.x);
            const y = Math.min(union.y, next.y);
            return {
              x,
              y,
              w: Math.max(union.x + union.w, next.x + next.w) - x,
              h: Math.max(union.y + union.h, next.y + next.h) - y,
            };
          },
          null,
        )
    : null;
  // Above the notes when there is room; Arrange occupies the top of the
  // canvas during a multi-selection, so otherwise go below them.
  const stickyBarTopLimit = state.selection.length > 1 ? 68 : 16;
  const stickyBarStyle = stickyBounds
    ? {
        top:
          stickyBounds.y - 64 >= stickyBarTopLimit
            ? stickyBounds.y - 64
            : Math.max(
                stickyBarTopLimit,
                Math.min(
                  stickyBounds.y + stickyBounds.h + 12,
                  host.clientHeight - 64,
                ),
              ),
        left: Math.max(
          88,
          Math.min(
            host.clientWidth - stickyBarWidth - 16,
            stickyBounds.x + stickyBounds.w / 2 - stickyBarWidth / 2,
          ),
        ),
        bottom: "auto",
        transform: "none",
      }
    : undefined;
  useLayoutEffect(() => {
    const width = stickyBarRef.current?.offsetWidth;
    if (width && Math.abs(width - stickyBarWidth) > 1) setStickyBarWidth(width);
  });
  const selectionKey = state.selection.map((item) => item.id).join(",");
  useEffect(() => setTextMenu(null), [selectionKey]);
  const stickyCss = useMemo(
    () =>
      stickyTextCss(
        state.items
          .filter((item) => item.kind === "note")
          .map((item) => ({ id: item.id, style: item.textStyle })),
      ),
    [state.items],
  );
  const notesLocked = stickySelection.every((note) => note.locked);
  // Selected words while editing; otherwise styles apply to whole notes.
  const textTarget = () => {
    const inline = inlineRef.current;
    if (!inline) return null;
    // The editor syncs its range a frame after the browser selection moves,
    // so read the live selection when it is inside the note.
    const selection = document.getSelection();
    const live =
      selection?.rangeCount && inline.rootElement?.contains(selection.anchorNode)
        ? inline.toInlineRange(selection.getRangeAt(0))
        : null;
    const range = live ?? inline.getInlineRange() ?? lastRange.current;
    return range && range.length > 0 ? { inline, range } : null;
  };
  const markActive = (mark: TextMark) => {
    const target = textTarget();
    return target
      ? Boolean(target.inline.getFormat(target.range)[mark])
      : stickySelection.length > 0 && stickySelection.every((note) => note.marks[mark]);
  };
  const toggleMark = (mark: TextMark) => {
    const target = textTarget();
    if (!target) return controller.toggleTextMark(mark);
    const on = !target.inline.getFormat(target.range)[mark];
    target.inline.formatText(target.range, { [mark]: on ? true : null });
    target.inline.setInlineRange(target.range);
    setInlineVersion((version) => version + 1);
  };
  const target = textTarget();
  const textColor = target
    ? (target.inline.getFormat(target.range).color ?? null)
    : stickySelection.every((note) => note.textColor === stickySelection[0]?.textColor)
      ? (stickySelection[0]?.textColor ?? null)
      : undefined;
  const applyTextColor = (color: string | null) => {
    const current = textTarget();
    if (current) {
      current.inline.formatText(current.range, { color });
      current.inline.setInlineRange(current.range);
      setInlineVersion((version) => version + 1);
    } else controller.setTextColor(color);
    setTextMenu(null);
  };
  const sharedStyle = <K extends keyof StickyTextStyle>(key: K) =>
    stickySelection.every((note) => note.textStyle[key] === stickySelection[0]?.textStyle[key])
      ? stickySelection[0]?.textStyle[key]
      : undefined;
  const applyTextStyle = (patch: Partial<StickyTextStyle>) => {
    controller.setTextStyle(patch);
    // A menu took focus from the editor; return it to the same selection.
    const inline = inlineRef.current;
    if (inline?.rootElement) {
      inline.rootElement.focus({ preventScroll: true });
      if (lastRange.current) inline.setInlineRange(lastRange.current);
    }
  };
  const onEditor = (inline: StickyInlineEditor | null) => {
    rangeSubscription.current?.unsubscribe();
    rangeSubscription.current = null;
    inlineRef.current = inline;
    lastRange.current = null;
    setInlineVersion((version) => version + 1);
    if (!inline) return;
    rangeSubscription.current = inline.slots.inlineRangeSync.subscribe(() => {
      const range = inline.getInlineRange();
      if (range) lastRange.current = range;
      setInlineVersion((version) => version + 1);
    });
  };
  useEffect(() => {
    host.classList.toggle("whiteboard-note-selection", noteSelection);
    return () => host.classList.remove("whiteboard-note-selection");
  }, [host, noteSelection]);
  const templateCards = [
    {
      id: "brainstorm" as const,
      title: "Brainstorm",
      description: "Collect ideas, explore them, and decide together.",
      columns: ["Ideas", "Explore", "Decide"],
    },
    {
      id: "retro" as const,
      title: "Retrospective",
      description:
        "Review what went well, what needs work, and what to do next.",
      columns: ["Went well", "Could be better", "Next steps"],
    },
    {
      id: "kanban" as const,
      title: "Kanban",
      description: "Track work from To do to Done.",
      columns: ["To do", "In progress", "Done"],
    },
    {
      id: "flow" as const,
      title: "Workflow",
      description: "Map a process with editable stickies and attached arrows.",
      columns: ["Start", "Review", "Decide", "Deliver"],
    },
  ];
  return (
    <div
      className={"canvas-chrome" + (modal ? " canvas-modal-open" : "")}
      ref={chromeRef}
    >
      {notice ? (
        <div className="canvas-notice" role="alert">
          <span>{notice}</span>
          <button
            className="canvas-icon-button small"
            type="button"
            aria-label="Dismiss message"
            onClick={() => setNotice("")}
          >
            <Icon name="close" />
          </button>
        </div>
      ) : null}
      {state.editing ? (
        <StickyTextEditor
          key={state.editing.id}
          state={state}
          controller={controller}
          host={host}
          onEditor={onEditor}
          onToggleMark={toggleMark}
        />
      ) : null}
      {placement && editable ? (
        <div
          className="canvas-placement-preview"
          aria-hidden="true"
          style={{
            left: placement.x,
            top: placement.y,
            width: (placement.tool === "sticky" ? 208 : 200) * state.zoom,
            height: (placement.tool === "sticky" ? 208 : 128) * state.zoom,
            background:
              placement.tool === "sticky" ? placement.options.color : undefined,
          }}
        >
          {placement.tool === "shape" ? (
            <svg
              viewBox="0 0 32 32"
              preserveAspectRatio="none"
              fill="var(--surface)"
              stroke="var(--text-secondary)"
              strokeWidth="0.5"
            >
              {
                SHAPES.find((shape) => shape.id === placement.options.shape)
                  ?.content
              }
            </svg>
          ) : null}
        </div>
      ) : null}
      {connectionPreview ? (
        <ConnectionPreview
          preview={connectionPreview}
          controller={controller}
        />
      ) : null}
      {editable &&
      state.tool === "select" &&
      !state.editing &&
      !stickySelection[0]?.locked &&
      stickySelection.length === 1 &&
      state.selection.length === 1 &&
      stickyBounds ? (
        <div className="sticky-connectors" aria-label="Sticky connections">
          {(["right", "down", "left", "up"] as Direction[]).map((direction) => {
            const [px, py] = CONNECTION_PORTS[direction].source;
            const x =
              stickyBounds.x +
              stickyBounds.w * px +
              (direction === "right" ? 14 : direction === "left" ? -14 : 0);
            const y =
              stickyBounds.y +
              stickyBounds.h * py +
              (direction === "down" ? 14 : direction === "up" ? -14 : 0);
            if (
              x < 80 ||
              x > host.clientWidth - 18 ||
              y < 18 ||
              y > host.clientHeight - 72
            )
              return null;
            const source = stickySelection[0].id;
            return (
              <button
                key={direction}
                type="button"
                className={"sticky-connect-handle " + direction}
                style={{ left: x, top: y }}
                aria-label={"Add connected sticky " + direction}
                title="Click to add a note · drag to connect"
                onPointerEnter={() =>
                  setConnectionPreview(
                    controller.connectionPreview(source, direction),
                  )
                }
                onPointerLeave={() => setConnectionPreview(null)}
                onPointerDown={(event) => {
                  dragIntent.current = { source, direction };
                  drag.start(event);
                }}
                onClick={() => {
                  dragIntent.current = null;
                  setConnectionPreview(null);
                  if (!drag.consumeClick())
                    controller.connectNext(direction, source);
                }}
              >
                <Icon name="plus" />
              </button>
            );
          })}
        </div>
      ) : null}
      <nav className="creation-rail" aria-label="Whiteboard tools">
        {TOOLS.map((tool, index) => (
          <div
            key={tool.id}
            className={"rail-tool-row" + (index === 2 ? " rail-divider" : "")}
          >
            <button
              type="button"
              className={
                "rail-tool" + (state.tool === tool.id ? " selected" : "")
              }
              aria-label={tool.label}
              aria-pressed={state.tool === tool.id}
              disabled={!editable && tool.id !== "select" && tool.id !== "hand"}
              onPointerDown={(event) => {
                if (!editable || (tool.id !== "sticky" && tool.id !== "shape"))
                  return;
                dragIntent.current = {
                  tool: tool.id,
                  options: optionsRef.current,
                };
                drag.start(event);
              }}
              onClick={() => {
                if (!drag.consumeClick()) useTool(tool.id);
              }}
            >
              {tool.id === "shape" ? (
                <svg
                  className="canvas-icon"
                  viewBox="0 0 32 32"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                >
                  {SHAPES.find((shape) => shape.id === options.shape)?.content}
                </svg>
              ) : tool.id === "sticky" ? (
                <span
                  className="rail-sticky-sample"
                  style={{ background: options.color }}
                >
                  <Icon name="sticky" />
                </span>
              ) : (
                <Icon name={tool.id} />
              )}
              <span className="rail-tooltip">
                {tool.label}
                <kbd>{tool.key}</kbd>
              </span>
            </button>
            {["sticky", "shape", "connector", "pen"].includes(tool.id) ? (
              <button
                type="button"
                className="rail-options"
                aria-label={tool.label + " options"}
                aria-expanded={palette === tool.id}
                disabled={!editable}
                onClick={() => {
                  const next = palette === tool.id ? null : tool.id;
                  controller.selectTool(tool.id, optionsRef.current);
                  setPalette(next);
                  setNavigation(null);
                }}
              >
                <svg
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d="m4 2 4 4-4 4" />
                </svg>
              </button>
            ) : null}
          </div>
        ))}
        <button
          className="rail-tool rail-divider"
          type="button"
          aria-label="Templates"
          disabled={!editable}
          onClick={() => {
            setPalette(null);
            setModal("templates");
          }}
        >
          <Icon name="templates" />
          <span className="rail-tooltip">Templates</span>
        </button>
        <button
          className="rail-tool"
          type="button"
          aria-label="Upload image"
          disabled={!editable}
          onClick={() => uploadRef.current?.click()}
        >
          <Icon name="upload" />
          <span className="rail-tooltip">Upload image</span>
        </button>
        <button
          className="rail-tool"
          type="button"
          aria-label="Add comment"
          disabled={!canComment}
          onClick={onComment}
        >
          <UiIcon name="comment" className="canvas-icon" />
          <span className="rail-tooltip">Comment</span>
        </button>
      </nav>
      <input
        ref={uploadRef}
        type="file"
        accept="image/*"
        className="sr-only"
        aria-label="Choose an image"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          void controller
            .uploadImage(file)
            .catch((error) =>
              setNotice(
                error instanceof Error
                  ? error.message
                  : "Image could not be added",
              ),
            );
          event.target.value = "";
        }}
      />
      <div className="canvas-history" role="group" aria-label="Edit history">
        <button
          className="canvas-icon-button"
          type="button"
          aria-label="Undo"
          title="Undo · ⌘Z"
          disabled={!editable || !state.canUndo}
          onClick={() => controller.undo()}
        >
          <Icon name="undo" />
        </button>
        <button
          className="canvas-icon-button"
          type="button"
          aria-label="Redo"
          title="Redo · ⌘⇧Z"
          disabled={!editable || !state.canRedo}
          onClick={() => controller.redo()}
        >
          <Icon name="redo" />
        </button>
      </div>
      {palette && editable ? (
        <section className="tool-palette" aria-label={palette + " options"}>
          <header>
            <strong>
              {palette === "sticky"
                ? "Sticky notes"
                : palette === "shape"
                  ? "Shapes"
                  : palette === "connector"
                    ? "Connection lines"
                    : "Drawing"}
            </strong>
            <button
              className="canvas-icon-button small"
              type="button"
              aria-label="Close tool options"
              onClick={() => setPalette(null)}
            >
              <Icon name="close" />
            </button>
          </header>
          {palette === "sticky" ? (
            <>
              <Palette
                color={options.color}
                onDragStart={(event, color) => {
                  const next = { ...optionsRef.current, color };
                  setOptions(next);
                  dragIntent.current = { tool: "sticky", options: next };
                  drag.start(event);
                }}
                consumeClick={drag.consumeClick}
                onChange={(color) => changeOptions({ color })}
              />
              <p className="palette-hint">
                Click the canvas or drag this tool to add a note.
              </p>
              <button
                className="palette-action"
                type="button"
                onClick={() => {
                  setPalette(null);
                  setModal("bulk");
                }}
              >
                Add multiple notes <Icon name="plus" />
              </button>
            </>
          ) : null}
          {palette === "shape" ? (
            <>
              <div className="shape-grid">
                {SHAPES.map((shape) => (
                  <button
                    type="button"
                    key={shape.id}
                    aria-label={shape.label}
                    aria-pressed={options.shape === shape.id}
                    title={shape.label}
                    onPointerDown={(event) => {
                      dragIntent.current = {
                        tool: "shape",
                        options: { ...optionsRef.current, shape: shape.id },
                      };
                      setOptions(dragIntent.current.options);
                      drag.start(event);
                    }}
                    onClick={() => {
                      if (!drag.consumeClick()) {
                        changeOptions({ shape: shape.id });
                        setPalette(null);
                        host.focus({ preventScroll: true });
                      }
                    }}
                  >
                    <svg
                      viewBox="0 0 32 32"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      {shape.content}
                    </svg>
                  </button>
                ))}
              </div>
              <p className="palette-hint">Click or drag to draw a shape.</p>
            </>
          ) : null}
          {palette === "connector" ? (
            <>
              <div className="line-choices">
                {[
                  {
                    id: ConnectorMode.Straight,
                    label: "Straight",
                    d: "M4 22 28 10",
                  },
                  {
                    id: ConnectorMode.Orthogonal,
                    label: "Elbow",
                    d: "M4 24h12V8h12",
                  },
                  {
                    id: ConnectorMode.Curve,
                    label: "Curved",
                    d: "M4 24C24 24 8 8 28 8",
                  },
                ].map((line) => (
                  <button
                    type="button"
                    key={line.id}
                    aria-pressed={options.line === line.id}
                    onClick={() => changeOptions({ line: line.id })}
                  >
                    <svg
                      viewBox="0 0 32 32"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                    >
                      <path d={line.d} />
                    </svg>
                    <span>{line.label}</span>
                  </button>
                ))}
              </div>
              <p className="palette-hint">
                Drag between objects. Lines stay attached as you move them.
              </p>
            </>
          ) : null}
          {palette === "pen" || palette === "eraser" ? (
            <>
              <div className="drawing-modes">
                <button
                  type="button"
                  aria-pressed={state.tool === "pen"}
                  onClick={() => useTool("pen")}
                >
                  <Icon name="pen" />
                  Pen
                </button>
                <button
                  type="button"
                  aria-pressed={state.tool === "eraser"}
                  onClick={() => useTool("eraser")}
                >
                  <Icon name="eraser" />
                  Eraser
                </button>
              </div>
              {palette === "pen" ? (
                <>
                  <div className="pen-colors">
                    {[
                      "#27334b",
                      "#4262ff",
                      "#ef6476",
                      "#16a080",
                      "#eead26",
                    ].map((color, index) => (
                      <button
                        type="button"
                        key={color}
                        aria-label={
                          ["Ink", "Blue", "Coral", "Green", "Gold"][index] +
                          " pen"
                        }
                        aria-pressed={options.penColor === color}
                        style={{
                          background:
                            color === "#27334b" ? "var(--text)" : color,
                        }}
                        onClick={() => changeOptions({ penColor: color })}
                      />
                    ))}
                  </div>
                  <label className="pen-width">
                    Stroke width{" "}
                    <select
                      value={options.penWidth}
                      onChange={(event) =>
                        changeOptions({
                          penWidth: Number(
                            event.target.value,
                          ) as CanvasOptions["penWidth"],
                        })
                      }
                    >
                      <option value={2}>Fine</option>
                      <option value={4}>Medium</option>
                      <option value={6}>Bold</option>
                      <option value={12}>Thick</option>
                    </select>
                  </label>
                </>
              ) : (
                <p className="palette-hint">Drag over a drawing to erase it.</p>
              )}
            </>
          ) : null}
        </section>
      ) : null}
      <div
        className="canvas-utilities"
        role="group"
        aria-label="Board navigation"
      >
        <button
          className={
            "canvas-icon-button" + (navigation === "search" ? " active" : "")
          }
          type="button"
          aria-label="Find on board"
          title="Find on board · ⌘F"
          onClick={() => {
            setNavigation(navigation === "search" ? null : "search");
            setPalette(null);
          }}
        >
          <Icon name="search" />
        </button>
        <button
          className={
            "canvas-icon-button" + (navigation === "frames" ? " active" : "")
          }
          type="button"
          aria-label="Frames"
          title="Frames"
          onClick={() =>
            setNavigation(navigation === "frames" ? null : "frames")
          }
        >
          <Icon name="frame" />
        </button>
        <button
          className="canvas-icon-button"
          type="button"
          aria-label="Toggle grid"
          aria-pressed={grid}
          title="Show grid"
          onClick={() => setGrid((value) => !value)}
        >
          <Icon name="grid" />
        </button>
      </div>
      {state.selection.length > 1 && editable ? (
        <div className="arrange-controls">
          <button
            type="button"
            aria-expanded={arranging}
            onClick={() => setArranging(!arranging)}
          >
            <Icon name="arrange" />
            Arrange <span>{state.selection.length}</span>
          </button>
          {arranging ? (
            <div className="arrange-menu">
              {(
                [
                  "left",
                  "center",
                  "right",
                  "top",
                  "middle",
                  "bottom",
                  "horizontal",
                  "vertical",
                  "grid",
                ] as Arrangement[]
              ).map((action) => (
                <button
                  key={action}
                  type="button"
                  disabled={
                    (action === "horizontal" || action === "vertical") &&
                    state.selection.length < 3
                  }
                  onClick={() => {
                    controller.arrange(action);
                    setArranging(false);
                  }}
                >
                  <UiIcon name={action === "grid" ? "arrange" : action} />
                  {
                    {
                      left: "Align left",
                      center: "Align center",
                      right: "Align right",
                      top: "Align top",
                      middle: "Align middle",
                      bottom: "Align bottom",
                      horizontal: "Distribute horizontally",
                      vertical: "Distribute vertically",
                      grid: "Tidy into a grid",
                    }[action]
                  }
                </button>
              ))}
              <button
                type="button"
                disabled={state.selection.some((item) => item.locked)}
                onClick={() => {
                  controller.groupSelection();
                  setArranging(false);
                }}
              >
                <Icon name="shape" /> Group selection
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {stickyCss ? <style>{stickyCss}</style> : null}
      {noteSelection && editable ? (
        <div
          className="sticky-selection-actions"
          ref={stickyBarRef}
          style={stickyBarStyle}
          aria-label="Sticky note actions"
          // Keep focus, and the text selection, in the note being edited.
          onMouseDown={(event) => {
            if (!(event.target as Element).closest("select")) event.preventDefault();
          }}
        >
          <Palette
            disabled={notesLocked}
            color={stickySelection[0].color}
            onChange={(color) => {
              setOptions((current) => ({ ...current, color }));
              controller.colorSelection(color);
            }}
          />
          <span className="selection-divider" />
          <select
            className="sticky-text-select"
            aria-label="Font"
            title="Font"
            disabled={notesLocked}
            value={sharedStyle("font") ?? ""}
            onChange={(event) =>
              applyTextStyle({ font: event.target.value as StickyTextStyle["font"] })
            }
          >
            {sharedStyle("font") ? null : <option value="" disabled>Mixed</option>}
            {STICKY_FONTS.map((font) => (
              <option key={font.id} value={font.id}>
                {font.name}
              </option>
            ))}
          </select>
          <select
            className="sticky-text-select"
            aria-label="Text size"
            title="Text size"
            disabled={notesLocked}
            value={sharedStyle("size") ?? ""}
            onChange={(event) =>
              applyTextStyle({ size: event.target.value as StickyTextStyle["size"] })
            }
          >
            {sharedStyle("size") ? null : <option value="" disabled>Mixed</option>}
            {STICKY_SIZES.map((size) => (
              <option key={size.id} value={size.id}>
                {size.name}
              </option>
            ))}
          </select>
          <span className="selection-divider" />
          {TEXT_MARKS.map((mark) => (
            <button
              key={mark}
              className="canvas-icon-button small"
              type="button"
              aria-label={MARK_SHORTCUTS[mark].label}
              aria-pressed={markActive(mark)}
              title={`${MARK_SHORTCUTS[mark].label} (${shortcutLabel(mark)})`}
              disabled={notesLocked}
              onClick={() => toggleMark(mark)}
            >
              <Icon name={mark} />
            </button>
          ))}
          <div className="sticky-text-menu">
            <button
              className="canvas-icon-button small text-color-button"
              type="button"
              aria-label="Text color"
              aria-expanded={textMenu === "textColor"}
              title="Text color"
              disabled={notesLocked}
              onClick={() =>
                setTextMenu((menu) => (menu === "textColor" ? null : "textColor"))
              }
            >
              <Icon name="textColor" />
              <span
                className="text-color-bar"
                style={{ background: textColor ?? "#303748" }}
              />
            </button>
            {textMenu === "textColor" ? (
              <div className="sticky-text-popover" role="group" aria-label="Text colors">
                {STICKY_TEXT_COLORS.map((color) => (
                  <button
                    key={color.name}
                    type="button"
                    aria-label={`${color.name} text`}
                    aria-pressed={textColor === color.value}
                    title={color.name}
                    style={{ color: color.value ?? "#303748" }}
                    onClick={() => applyTextColor(color.value)}
                  >
                    A
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="sticky-text-menu">
            <button
              className="canvas-icon-button small"
              type="button"
              aria-label="Text alignment"
              aria-expanded={textMenu === "align"}
              title="Text alignment"
              disabled={notesLocked}
              onClick={() => setTextMenu((menu) => (menu === "align" ? null : "align"))}
            >
              <Icon name={ALIGN_ICONS[sharedStyle("align") ?? "left"]} />
            </button>
            {textMenu === "align" ? (
              <div className="sticky-text-popover" role="group" aria-label="Text alignment">
                {STICKY_ALIGNMENTS.map((align) => (
                  <button
                    key={align.id}
                    type="button"
                    aria-label={align.name}
                    aria-pressed={sharedStyle("align") === align.id}
                    title={align.name}
                    onClick={() => {
                      applyTextStyle({ align: align.id });
                      setTextMenu(null);
                    }}
                  >
                    <Icon name={ALIGN_ICONS[align.id]} />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <span className="selection-divider" />
          <button
            className="canvas-icon-button small"
            type="button"
            aria-label="Duplicate selection"
            title="Duplicate"
            onClick={() => void controller.duplicateSelection()}
          >
            <Icon name="duplicate" />
          </button>
          <button
            className="canvas-icon-button small"
            type="button"
            aria-label={notesLocked ? "Unlock notes" : "Lock notes"}
            title="Lock or unlock"
            onClick={() => controller.lockSelection()}
          >
            <Icon name="lock" />
          </button>
          {state.selection.length === 1 && !stickySelection[0].locked ? (
            <>
              <span className="selection-divider" />
              <button
                type="button"
                title="Add a connected step to the right"
                aria-label="Add connected sticky"
                onClick={() => controller.connectNext("right")}
              >
                <Icon name="arrow" />
                <span>Next step</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {navigation ? (
        <aside
          className={"canvas-navigator " + navigation}
          aria-label={
            navigation === "search"
              ? "Board search"
              : navigation === "frames"
                ? "Frame navigation"
                : "Board overview"
          }
        >
          <header>
            <strong>
              {navigation === "search"
                ? "Find on board"
                : navigation === "frames"
                  ? "Frames"
                  : "Overview"}
            </strong>
            <button
              className="canvas-icon-button small"
              type="button"
              aria-label="Close navigation"
              onClick={() => setNavigation(null)}
            >
              <Icon name="close" />
            </button>
          </header>
          {navigation === "search" ? (
            <>
              <input
                autoFocus
                aria-label="Search board text"
                placeholder="Search notes, shapes, text…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query.trim() ? (
                <p className="navigator-meta">
                  {matches.length} {matches.length === 1 ? "result" : "results"}
                </p>
              ) : (
                <p className="navigator-empty">
                  Find an idea, even on a large board.
                </p>
              )}
              <div className="navigator-list">
                {matches.slice(0, 100).map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => controller.select(item.id)}
                  >
                    <span
                      className="result-swatch"
                      style={{ background: item.color }}
                    />
                    <span>
                      <small>{item.kind}</small>
                      <strong>{item.text.slice(0, 100)}</strong>
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : navigation === "frames" ? (
            <>
              {frames.length ? (
                <div className="navigator-list">
                  {frames.map((frame, index) => (
                    <button
                      type="button"
                      key={frame.id}
                      onClick={() => controller.select(frame.id)}
                    >
                      <span className="frame-number">{index + 1}</span>
                      <strong>{frame.text || "Untitled frame"}</strong>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="navigator-empty">
                  Add frames with F to organize your board into areas.
                </p>
              )}
            </>
          ) : (
            <BoardOverview state={state} controller={controller} />
          )}
        </aside>
      ) : null}
      <div className="canvas-bottom-right">
        <button
          className="canvas-icon-button overview-button"
          type="button"
          aria-label="Board overview"
          title="Board overview"
          onClick={() => setNavigation(navigation === "map" ? null : "map")}
        >
          <Icon name="map" />
        </button>
        <div className="canvas-zoom">
          <button
            className="canvas-icon-button"
            type="button"
            aria-label="Zoom out"
            onClick={() => controller.zoom(state.zoom / 1.2)}
          >
            <Icon name="minus" />
          </button>
          <button
            className="zoom-value"
            type="button"
            aria-label="Zoom options"
            aria-expanded={zoomMenu}
            onClick={() => setZoomMenu(!zoomMenu)}
          >
            {Math.round(state.zoom * 100)}%
          </button>
          <button
            className="canvas-icon-button"
            type="button"
            aria-label="Zoom in"
            onClick={() => controller.zoom(state.zoom * 1.2)}
          >
            <Icon name="plus" />
          </button>
          <span />
          <button
            className="canvas-icon-button"
            type="button"
            aria-label="Fit board"
            title="Fit board"
            onClick={() => controller.fit()}
          >
            <Icon name="fit" />
          </button>
        </div>
        <button
          className="canvas-icon-button help-button"
          type="button"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts"
          onClick={() => setModal("help")}
        >
          <Icon name="help" />
        </button>
        {zoomMenu ? (
          <div className="zoom-menu">
            <button
              type="button"
              onClick={() => {
                controller.fit();
                setZoomMenu(false);
              }}
            >
              Fit board
            </button>
            <button
              type="button"
              disabled={!state.selection.length}
              onClick={() => {
                controller.fit(state.selection.map((i) => i.id));
                setZoomMenu(false);
              }}
            >
              Fit selection
            </button>
            <button
              type="button"
              onClick={() => {
                controller.zoom(1);
                setZoomMenu(false);
              }}
            >
              100%
            </button>
          </div>
        ) : null}
      </div>
      {!state.items.length &&
      editable &&
      (state.tool === "select" || state.tool === "hand") ? (
        <div className="canvas-empty">
          <span className="empty-note-mark">
            <Icon name="sticky" />
          </span>
          <h2>Start with one idea</h2>
          <p>Add a sticky note, sketch a flow, or start from a template.</p>
          <div>
            <button
              type="button"
              className="canvas-primary"
              onClick={() => useTool("sticky")}
            >
              <Icon name="plus" />
              Add a sticky note
            </button>
            <button type="button" onClick={() => setModal("templates")}>
              Browse templates
            </button>
          </div>
          <small>Press N for a note · Scroll or right-drag to move around</small>
        </div>
      ) : null}
      <div className="canvas-mode-hint">
        {!editable
          ? "View only"
          : state.tool === "sticky"
            ? "Click to place a sticky note"
            : state.tool === "connector"
              ? "Drag between two objects to connect them"
              : state.tool === "hand"
                ? "Drag to move around the board"
                : state.tool === "frame"
                  ? "Drag around an area to add a frame"
                  : state.tool === "shape"
                    ? "Click or drag to add a shape"
                    : null}
      </div>
      {modal === "bulk" ? (
        <Modal title="Add multiple sticky notes" onClose={() => setModal(null)}>
          <p className="modal-description">
            One idea per line. You can move and edit each note on the board.
          </p>
          <textarea
            autoFocus
            aria-label="Sticky note ideas"
            placeholder={
              "What should we explore?\nWhat is holding us back?\nWhat could we try next?"
            }
            value={bulk}
            onChange={(event) => setBulk(event.target.value)}
            maxLength={30_000}
          />
          <div className="bulk-footer">
            <Palette
              color={options.color}
              onChange={(color) =>
                setOptions((current) => ({ ...current, color }))
              }
            />
            <span>
              {lines.length} notes
              {bulk.split("\n").filter((l) => l.trim()).length > 100
                ? " · first 100 will be added"
                : ""}
            </span>
          </div>
          <footer>
            <button type="button" onClick={() => setModal(null)}>
              Cancel
            </button>
            <button
              className="canvas-primary"
              type="button"
              disabled={!lines.length}
              onClick={() => {
                controller.addNotes(lines, options.color);
                setBulk("");
                setModal(null);
              }}
            >
              Add {lines.length || ""} notes
            </button>
          </footer>
        </Modal>
      ) : null}
      {modal === "templates" ? (
        <Modal title="Templates" onClose={() => setModal(null)} wide>
          <div className="patterns-intro"><p className="modal-description">
            Start from a board that is already laid out, then change anything
            you like. Every note, shape and arrow stays editable.
          </p><img src="/brand/patterns.webp" alt="" width="1254" height="1254" /></div>
          <div className="canvas-template-grid">
            {DEMO_PATTERNS.map(pattern => (
              <button type="button" key={pattern.id} className="canvas-template-card"
                onClick={() => { controller.insertTemplate(pattern.id); setModal(null); }}>
                <div className="template-preview demo-pattern-preview"><PatternPreview pattern={pattern} /></div>
                <strong>{pattern.title}</strong>
                <p>{pattern.description}</p>
                <span>{pattern.id === "update-flow" ? "Explore the demo" : "Use template"} <Icon name="arrow" /></span>
              </button>
            ))}
            {templateCards.map((template) => (
              <button
                type="button"
                key={template.id}
                className="canvas-template-card"
                onClick={() => {
                  controller.insertTemplate(template.id);
                  setModal(null);
                }}
              >
                <div className={"template-preview " + template.id}>
                  {template.columns.map((column, index) => (
                    <div key={column}>
                      <small>{column}</small>
                      {(template.id === "flow" ? [0] : [0, 1, 2]).map((row) => (
                        <i
                          key={row}
                          style={{ background: STICKY_COLORS[index].value }}
                        />
                      ))}
                    </div>
                  ))}
                </div>
                <strong>{template.title}</strong>
                <p>{template.description}</p>
                <span>
                  Use template <Icon name="arrow" />
                </span>
              </button>
            ))}
          </div>
        </Modal>
      ) : null}
      {modal === "help" ? (
        <Modal title="Keyboard shortcuts" onClose={() => setModal(null)}>
          <button className="canvas-primary" onClick={()=>{setModal(null);openTour();}}>Take a quick board tour</button>
          <p className="modal-description">
            Less reaching for tools. More time for your ideas.
          </p>
          <div className="shortcut-list">
            {TOOLS.map((tool) => (
              <div key={tool.id}>
                <span>
                  <Icon name={tool.id} />
                  {tool.label}
                </span>
                <kbd>{tool.key}</kbd>
              </div>
            ))}
            {[
              ["Undo / redo", "⌘ Z / ⌘ ⇧ Z"],
              ["Copy / paste", "⌘ C / ⌘ V"],
              ["Duplicate", "⌘ D"],
              ["Group / ungroup", "⌘ G / ⌘ ⇧ G"],
              ["Bold / italic / underline", "⌘ B / ⌘ I / ⌘ U"],
              ["Strikethrough", "⌘ ⇧ X"],
              ["Pan temporarily", "Space + drag"],
              ["Pan", "Scroll, or right-drag on blank canvas"],
              ["Select an area", "Drag on blank canvas"],
              ["Find on board", "⌘ F"],
              ["Finish editing / deselect", "Esc"],
              ["Laser pointer", "Shift + L"],
            ].map(([label, key]) => (
              <div key={label}>
                <span>{label}</span>
                <kbd>{key}</kbd>
              </div>
            ))}
          </div>
          <p className="shortcut-note">
            Use Ctrl instead of ⌘ on Windows and Linux. Double-click an object
            to edit its text.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
function BoardOverview({
  state,
  controller,
}: {
  state: CanvasState;
  controller: CanvasController;
}) {
  if (!state.items.length)
    return (
      <p className="navigator-empty">Your board overview will appear here.</p>
    );
  const boxes = state.items.filter((item) => item.kind !== "connector");
  if (!boxes.length)
    return (
      <p className="navigator-empty">Add objects to see the board overview.</p>
    );
  const x = Math.min(...boxes.map((b) => b.x)),
    y = Math.min(...boxes.map((b) => b.y));
  const width = Math.max(...boxes.map((b) => b.x + b.w)) - x || 1;
  const height = Math.max(...boxes.map((b) => b.y + b.h)) - y || 1;
  return (
    <>
      <svg
        className="board-minimap"
        viewBox={[x - 20, y - 20, width + 40, height + 40].join(" ")}
        role="group"
        aria-label="Objects on board"
      >
        {boxes.slice(0, 500).map((item) => (
          <g
            key={item.id}
            role="button"
            tabIndex={0}
            aria-label={item.text || item.kind}
            onClick={() => controller.select(item.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                controller.select(item.id);
              }
            }}
          >
            <rect
              x={item.x}
              y={item.y}
              width={item.w}
              height={item.h}
              rx={3}
              fill={item.kind === "frame" ? "none" : item.color}
              stroke={item.kind === "frame" ? "#b8c2d3" : "#7f8ca4"}
              strokeWidth={Math.max(1, width / 400)}
            />
          </g>
        ))}
      </svg>
      <button
        className="overview-fit"
        type="button"
        onClick={() => controller.fit()}
      >
        Show the whole board
      </button>
    </>
  );
}

function StickyTextEditor({
  state,
  controller,
  host,
  onEditor,
  onToggleMark,
}: {
  state: CanvasState;
  controller: CanvasController;
  host: HTMLElement;
  onEditor: (editor: StickyInlineEditor | null) => void;
  onToggleMark: (mark: TextMark) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inlineRef = useRef<StickyInlineEditor | null>(null);
  const onEditorRef = useRef(onEditor);
  onEditorRef.current = onEditor;
  const editing = state.editing!;
  const bounds = controller.viewBounds(editing.id);
  const yText = controller.editingText()?.yText ?? null;
  useEffect(() => {
    const root = ref.current;
    if (!root || !yText) return;
    // The rich editor writes straight to the note's shared text, so edits
    // from collaborators and undo land in place without a draft to merge.
    const inline = createStickyInlineEditor(yText);
    inline.mount(root);
    inlineRef.current = inline;
    root.focus({ preventScroll: true });
    inline.focusEnd();
    onEditorRef.current(inline);
    host.classList.add("sticky-text-editing");
    return () => {
      host.classList.remove("sticky-text-editing");
      onEditorRef.current(null);
      inlineRef.current = null;
      inline.unmount();
    };
  }, [host, yText]);
  if (!bounds) return null;
  const style = editing.textStyle;
  return (
    <div
      ref={ref}
      className="sticky-text-editor"
      role="textbox"
      aria-multiline="true"
      aria-label="Edit sticky note"
      spellCheck
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.w,
        height: bounds.h,
        background: editing.color,
        fontSize: stickySizePx(style.size) * state.zoom,
        fontFamily: stickyFontCss(style.font) ?? undefined,
        textAlign: style.align,
        padding: 24 * state.zoom,
        lineHeight: 1.4,
      }}
      onBlur={(event) => {
        // Toolbar menus take focus without ending the edit.
        const next = event.relatedTarget;
        if (next instanceof Element && next.closest(".sticky-selection-actions")) return;
        controller.finishEditing(editing.id);
      }}
      onPaste={(event) => {
        event.preventDefault();
        const inline = inlineRef.current;
        const range = inline?.getInlineRange();
        if (!inline || !range) return;
        const text = pastedStickyText(
          event.clipboardData.getData("text/plain"),
          inline.yTextLength,
          range.length,
        );
        inline.insertText(range, text);
        inline.setInlineRange({ index: range.index + text.length, length: 0 });
      }}
      onDrop={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const mark = markForShortcut(event);
        if (mark) {
          event.preventDefault();
          event.stopPropagation();
          onToggleMark(mark);
        } else if (
          event.key.toLowerCase() === "z" &&
          (event.metaKey || event.ctrlKey)
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) controller.redo();
          else controller.undo();
        } else if (
          event.key === "Escape" ||
          (event.key === "Enter" && (event.metaKey || event.ctrlKey))
        ) {
          event.preventDefault();
          event.stopPropagation();
          controller.finishEditing();
          host.focus({ preventScroll: true });
        } else if (event.key === "Tab" && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          controller.addAdjacentNote();
        }
      }}
    />
  );
}
