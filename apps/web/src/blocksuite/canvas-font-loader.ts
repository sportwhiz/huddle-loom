import { IS_FIREFOX } from '@blocksuite/affine/global/env';
import { createIdentifierFromConstructor } from '@blocksuite/affine/global/di';
import { FontConfigIdentifier, FontLoaderService, type FontConfig } from '@blocksuite/affine/shared/services';
import { StdIdentifier } from '@blocksuite/std';
import * as Y from 'yjs';

/** Register the font menu, but download only fonts the document actually uses. */
export class CanvasFontLoader extends FontLoaderService {
  private readonly configured: Array<{ config: FontConfig; face: FontFace }> = [];
  private readonly requested = new Set<FontFace>();
  private active = false;

  override get ready() {
    return Promise.all([...this.requested].map(face => face.loaded));
  }

  override load(fonts: FontConfig[]) {
    for (const config of fonts) {
      const face = new FontFace(IS_FIREFOX ? `"${config.font}"` : config.font, `url(${config.url})`, {
        weight: config.weight, style: config.style, display: 'swap',
      });
      document.fonts.add(face);
      this.fontFaces.push(face);
      this.configured.push({ config, face });
    }
  }

  private readonly useFont = (map: Y.Map<unknown>) => {
    const family = map.get('prop:fontFamily') ?? map.get('fontFamily');
    if (typeof family !== 'string') return;
    const weight = String(map.get('prop:fontWeight') ?? map.get('fontWeight') ?? '400');
    const style = String(map.get('prop:fontStyle') ?? map.get('fontStyle') ?? 'normal');
    const configured = this.configured.filter(item => item.config.font === family);
    const styled = configured.filter(item => item.config.style === style);
    const candidates = styled.length ? styled : configured;
    const wantedWeight = Number(weight) || (weight === 'bold' ? 700 : 400);
    const matching = configured.find(item => item.config.weight === weight && item.config.style === style) ??
      candidates.reduce<(typeof candidates)[number] | undefined>((nearest, item) =>
        !nearest || Math.abs(Number(item.config.weight) - wantedWeight) < Math.abs(Number(nearest.config.weight) - wantedWeight)
          ? item : nearest, undefined);
    if (!matching || this.requested.has(matching.face)) return;
    this.requested.add(matching.face);
    void matching.face.load().then(() => {
      if (!this.active) return;
      const root = this.std.store.root;
      const view = root ? this.std.view.getBlock(root.id) : null;
      (view as typeof view & { surface?: { refresh(): void } })?.surface?.refresh();
    }).catch(console.error);
  };

  private readonly changed = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    for (const event of events) {
      if (!(event instanceof Y.YMapEvent)) continue;
      this.useFont(event.target);
      // Newly inserted blocks and surface elements already contain their font
      // properties when their parent map emits the insertion event.
      for (const key of event.keysChanged) {
        const value = event.target.get(key);
        if (value instanceof Y.Map) this.useFont(value);
      }
    }
  };

  override mounted() {
    this.active = true;
    this.load(this.std.getOptional(FontConfigIdentifier) ?? []);
    const blocks = this.std.store.spaceDoc.getMap<Y.Map<unknown>>('blocks');
    blocks.forEach(block => {
      this.useFont(block);
      const boxed = block.get('prop:elements');
      const elements = boxed instanceof Y.Map ? boxed.get('value') : undefined;
      if (elements instanceof Y.Map) elements.forEach(element => { if (element instanceof Y.Map) this.useFont(element); });
    });
    blocks.observeDeep(this.changed);
  }

  override unmounted() {
    this.active = false;
    this.std.store.spaceDoc.getMap('blocks').unobserveDeep(this.changed);
    super.unmounted();
    this.configured.length = 0;
    this.requested.clear();
  }

  static override setup(di: Parameters<typeof FontLoaderService.setup>[0]) {
    di.override(createIdentifierFromConstructor(FontLoaderService), CanvasFontLoader, [StdIdentifier]);
  }
}
