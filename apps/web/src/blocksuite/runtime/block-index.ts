import type { Schema, YBlock } from '@blocksuite/affine/store';
import * as Y from 'yjs';

/** Index structural fields without converting document text or tables to JSON. */
export class NativeBlockIndex {
  private flavours: Map<string, string[]> | undefined;
  private orderedIds: string[] = [];
  private parents = new Map<string, Map<string, string>>();
  private roots = new WeakMap<Schema, string | null>();
  readDuringMutation = false;

  private readonly mutationStarted = () => { this.readDuringMutation = true; };
  private readonly observersStarted = () => { this.readDuringMutation = false; };

  constructor(private readonly blocks: Y.Map<YBlock>) {
    blocks.observeDeep(this.changed);
    blocks.doc?.on('beforeTransaction', this.mutationStarted);
    blocks.doc?.on('beforeObserverCalls', this.observersStarted);
    blocks.doc?.on('afterTransaction', this.observersStarted);
  }

  private readonly changed = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    for (const event of events) {
      const target = event.target;
      const blockMap = target instanceof Y.Map && target.parent === this.blocks;
      if (target === this.blocks || (blockMap && (event as Y.YMapEvent<unknown>).keysChanged.has('sys:flavour'))) {
        this.flavours = undefined;
        this.roots = new WeakMap();
        this.parents.clear();
      } else if ((blockMap && (event as Y.YMapEvent<unknown>).keysChanged.has('sys:children')) ||
        (target instanceof Y.Array && target.parent instanceof Y.Map &&
          target.parent.parent === this.blocks && target.parent.get('sys:children') === target)) {
        this.parents.clear();
      }
    }
  };

  private indexFlavours() {
    if (this.flavours) return this.flavours;
    this.flavours = new Map();
    // Object keys reproduce the native store's ordering, including numeric IDs.
    this.orderedIds = Object.keys(Object.fromEntries(this.blocks));
    for (const id of this.orderedIds) {
      const flavour = this.blocks.get(id)?.get('sys:flavour');
      if (typeof flavour !== 'string') continue;
      const ids = this.flavours.get(flavour) ?? [];
      ids.push(id);
      this.flavours.set(flavour, ids);
    }
    return this.flavours;
  }

  idsFor(flavour: string | string[]) {
    const index = this.indexFlavours();
    if (typeof flavour === 'string') return index.get(flavour) ?? [];
    const wanted = new Set(flavour.flatMap(value => index.get(value) ?? []));
    return this.orderedIds.filter(id => wanted.has(id));
  }

  rootId(schema: Schema) {
    if (this.roots.has(schema)) return this.roots.get(schema) ?? null;
    this.indexFlavours();
    let root: string | null = null;
    for (const id of this.orderedIds) {
      const flavour = this.blocks.get(id)?.get('sys:flavour');
      if (typeof flavour === 'string' && schema.flavourSchemaMap.get(flavour)?.model.role === 'root') root = id;
    }
    this.roots.set(schema, root);
    return root;
  }

  parentId(id: string, root: string | null) {
    if (!root || id === root) return null;
    let index = this.parents.get(root);
    if (!index) {
      index = new Map();
      const visited = new Set<string>();
      const walk = (parent: string) => {
        if (visited.has(parent)) return;
        visited.add(parent);
        const children = this.blocks.get(parent)?.get('sys:children');
        if (!(children instanceof Y.Array)) return;
        for (const child of children.toArray()) {
          if (typeof child !== 'string') continue;
          if (!index!.has(child)) index!.set(child, parent);
          walk(child);
        }
      };
      walk(root);
      this.parents.set(root, index);
    }
    return index.get(id) ?? null;
  }

  dispose() {
    this.blocks.unobserveDeep(this.changed);
    this.blocks.doc?.off('beforeTransaction', this.mutationStarted);
    this.blocks.doc?.off('beforeObserverCalls', this.observersStarted);
    this.blocks.doc?.off('afterTransaction', this.observersStarted);
    this.flavours = undefined;
    this.parents.clear();
    this.orderedIds = [];
  }
}
