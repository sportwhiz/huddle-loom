// Compatible with BlockSuite 0.22.4's MIT-licensed CodeBlockHighlighter.
// Keep its service identity and themes; initialize the engine only for code.
import { CodeBlockConfigExtension } from '@blocksuite/affine/blocks/code';
import { ColorScheme } from '@blocksuite/affine/model';
import { ThemeProvider } from '@blocksuite/affine/shared/services';
import { LifeCycleWatcher } from '@blocksuite/std';
import { signal } from '@preact/signals-core';
import type { HighlighterCore, MaybeGetter } from 'shiki';

export class CodeBlockHighlighter extends LifeCycleWatcher {
  static override key = 'code-block-highlighter';
  private darkThemeKey: string | undefined;
  private lightThemeKey: string | undefined;
  private active = false;
  private loading: Promise<void> | undefined;
  private changes: { unsubscribe(): void } | undefined;
  highlighter$ = signal<HighlighterCore | null>(null);

  get themeKey() {
    return this.std.get(ThemeProvider).theme$.value === ColorScheme.Dark
      ? this.darkThemeKey : this.lightThemeKey;
  }

  private readonly loadForCode = () => {
    if (!this.active || this.loading || this.highlighter$.value || !this.std.store.getBlocksByFlavour('affine:code').length) return;
    this.loading = this.load().catch(console.error).finally(() => { this.loading = undefined; });
  };

  private async load() {
    const [{ createHighlighterCore }, { createOnigurumaEngine }, wasm] = await Promise.all([
      import('shiki/core'), import('shiki/engine/oniguruma'), import('shiki/wasm'),
    ]);
    if (!this.active) return;
    const highlighter = await createHighlighterCore({ engine: createOnigurumaEngine(() => wasm.default) });
    try {
      const config = this.std.getOptional(CodeBlockConfigExtension.identifier);
      const dark = config?.theme?.dark ?? import('shiki/themes/dark-plus.mjs');
      const light = config?.theme?.light ?? import('shiki/themes/light-plus.mjs');
      const [darkTheme, lightTheme] = await Promise.all([normalizeGetter(dark), normalizeGetter(light)]);
      await highlighter.loadTheme(darkTheme, lightTheme);
      if (!this.active) { highlighter.dispose(); return; }
      this.darkThemeKey = darkTheme.name;
      this.lightThemeKey = lightTheme.name;
      this.highlighter$.value = highlighter;
    } catch (error) {
      highlighter.dispose();
      throw error;
    }
  }

  override mounted() {
    this.active = true;
    this.changes = this.std.store.slots.blockUpdated.subscribe(this.loadForCode);
    this.loadForCode();
  }

  override unmounted() {
    this.active = false;
    this.changes?.unsubscribe();
    this.highlighter$.value?.dispose();
    this.highlighter$.value = null;
  }
}

export async function normalizeGetter<T>(value: MaybeGetter<T>): Promise<T> {
  const resolved = await (typeof value === 'function' ? (value as () => T)() : value);
  return resolved && typeof resolved === 'object' && 'default' in resolved ? resolved.default as T : resolved as T;
}
