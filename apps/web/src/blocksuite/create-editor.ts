import { RefNodeSlotsProvider } from "@blocksuite/affine/inlines/reference";
import { canvasFitPadding } from "./canvas-layout";
import {
  CommunityCanvasTextFonts,
  DocModeProvider,
  EditorSettingExtension,
  FeatureFlagService,
  FontConfigExtension,
  ParseDocUrlExtension,
  ToolbarModuleIdentifier,
  ThemeProvider,
  ThemeService,
} from "@blocksuite/affine/shared/services";
import { themeToVar } from "@toeverything/theme/v2";
import { ColorScheme } from "@blocksuite/affine/model";
import { StdIdentifier } from "@blocksuite/std";
import type { ExtensionType, Store, Workspace } from "@blocksuite/affine/store";
import { GfxControllerIdentifier } from "@blocksuite/std/gfx";
import { BlockFlavourIdentifier } from "@blocksuite/std";
import "./editor-container";
import {
  combinedDarkCssVariables,
  combinedLightCssVariables,
} from "@toeverything/theme";

import type { WhiteboardEditorElement } from "./editor-container";
import { getViewExtensions } from "./view-extensions";
import { CanvasShapeTool, StickyTool } from "./canvas-controller";
import { legacyStickyPaper } from "./sticky-paper";
import { CanvasFontLoader } from "./canvas-font-loader";
import { CanvasNavigationTool } from "./canvas-navigation-tool";
import {
  createDocModeProvider,
  createEditorSetting,
  createParseDocUrlService,
} from "./services";

/** Early boards stored the product's neutral line colors as light-only hex.
 * Adapt those defaults at render time, keeping the saved document unchanged. */
class CanvasThemeService extends ThemeService {
  override generateColorProperty(
    ...args: Parameters<ThemeService["generateColorProperty"]>
  ) {
    const paper = legacyStickyPaper(args[0]);
    if (paper) return paper;
    return super.generateColorProperty(...args);
  }
  override getColorValue(...args: Parameters<ThemeService["getColorValue"]>) {
    const value = super.getColorValue(...args);
    if (this.edgelessTheme !== ColorScheme.Dark) return value;
    return value === "#5c6980"
      ? "#aab7cf"
      : value === "#425574"
        ? "#b9c5dc"
        : value;
  }
  override getCssVariableColor(...args: Parameters<ThemeService["getCssVariableColor"]>) {
    if (args[0] === themeToVar("edgeless/frame/background/white")) {
      const theme = args[1] ?? this.theme$.value;
      return theme === ColorScheme.Dark ? "#202630" : "#ffffff";
    }
    return super.getCssVariableColor(...args);
  }
  static override setup(di: Parameters<typeof ThemeService.setup>[0]) {
    di.override(ThemeProvider, CanvasThemeService, [StdIdentifier]);
  }
}

export function createEditor(store: Store, workspace: Workspace) {
  store
    .get(FeatureFlagService)
    .setFlag("enable_advanced_block_visibility", true);
  // Canvas labels use the engine's text element editor. The document-style
  // text block offers linked-page/table actions that this whiteboard lacks.
  store.get(FeatureFlagService).setFlag("enable_edgeless_text", false);

  const editor = document.createElement(
    "whiteboard-editor",
  ) as WhiteboardEditorElement;
  editor.autofocus = true;
  editor.doc = store;
  editor.mode = "edgeless";
  // Native popovers and handles require the engine's full token set. Scope it
  // to the editor so defaults never restyle workspace or collaboration panels.
  for (const [name, value] of Object.entries(
    document.documentElement.dataset.theme === "dark"
      ? combinedDarkCssVariables
      : combinedLightCssVariables,
  )) {
    editor.style.setProperty(name, value);
  }
  editor.style.setProperty("--affine-blue", "#4262ff");
  editor.style.setProperty("--affine-primary-color", "#4262ff");
  editor.style.setProperty(
    "--affine-font-family",
    "Arial, Helvetica, sans-serif",
  );
  editor.style.setProperty(
    "--affine-note-shadow-box",
    "0 2px 5px rgb(35 48 74 / 8%)",
  );

  const commonExtensions: ExtensionType[] = [
    CanvasThemeService,
    CanvasFontLoader,
    FontConfigExtension(CommunityCanvasTextFonts),
    EditorSettingExtension({ setting$: createEditorSetting() }),
    ParseDocUrlExtension(createParseDocUrlService(workspace)),
    {
      setup: (di) => {
        di.override(DocModeProvider, createDocModeProvider(editor));
      },
    },
  ];
  editor.pageSpecs = [...getViewExtensions("page"), ...commonExtensions];
  editor.edgelessSpecs = [
    ...getViewExtensions("edgeless"),
    ...commonExtensions,
    CanvasNavigationTool,
    StickyTool,
    CanvasShapeTool,
    {
      setup: (di) => {
        for (const flavour of ["group", "frame"]) {
          const id = BlockFlavourIdentifier(`affine:surface:${flavour}`);
          const identifier = ToolbarModuleIdentifier(id.variant);
          const module = di.provider().get(identifier);
          di.override(identifier, {
            ...module,
            config: {
              ...module.config,
              actions: module.config.actions?.filter(
                (action) => action.id !== "a.insert-into-page",
              ),
            },
          });
        }
      },
    },
  ];

  editor.std
    .get(RefNodeSlotsProvider)
    .docLinkClicked.subscribe(({ pageId: docId }) => {
      const target = workspace.getDoc(docId)?.getStore();
      if (!target) {
        return;
      }
      target.load();
      editor.doc = target;
    });

  return editor;
}

export function fitEditorToContent(editor: WhiteboardEditorElement) {
  let secondFrame = 0;
  const firstFrame = requestAnimationFrame(() => {
    secondFrame = requestAnimationFrame(() => {
      const gfx = editor.std.get(GfxControllerIdentifier);
      const host = editor.closest<HTMLElement>(".editor-canvas");
      // Show the complete composition, including documents outside a frame.
      gfx.fitToScreen({
        smooth: false,
        padding: host ? canvasFitPadding(host) : [96, 88, 80, 88],
      });
    });
  });
  return () => {
    cancelAnimationFrame(firstFrame);
    cancelAnimationFrame(secondFrame);
  };
}
