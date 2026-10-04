// Adapted from BlockSuite's MIT-licensed StoreContainer. Store behavior remains
// native; the product adds indexed reads at its existing workspace boundary.
import {
  DocIdentifier,
  Store,
  type Block,
  type BlockModel,
  type Doc,
  type ExtensionType,
  type GetStoreOptions,
  type RemoveStoreOptions,
} from '@blocksuite/affine/store';
import type { NativeDoc } from './doc';

export class IndexedStore extends Store {
  private readonly memberships = new Map<string, Record<string, true>>();
  private readonly orderedModels: Record<string, true> = Object.create(null);
  private readonly trackedModels = new Set<BlockModel>();

  constructor(options: ConstructorParameters<typeof Store>[0]) {
    super(options);
    // Raw indexes serve the base constructor. Once its models exist, retain
    // their own insertion order: undo can recreate a model after its peers.
    for (const model of this.getAllModels()) this.trackModel(model);
    this.disposableGroup.add(this.slots.blockUpdated.subscribe(event => {
      if (event.type === 'add') this.trackModel(event.model);
    }));
  }

  private trackModel(model: BlockModel) {
    if (this.trackedModels.has(model)) return;
    this.trackedModels.add(model);
    const ids = this.memberships.get(model.flavour) ?? Object.create(null) as Record<string, true>;
    ids[model.id] = true;
    this.memberships.set(model.flavour, ids);
    this.orderedModels[model.id] = true;
    this.disposableGroup.add(model.deleted.subscribe(() => {
      delete ids[model.id];
      delete this.orderedModels[model.id];
      this.trackedModels.delete(model);
    }));
  }

  private get blockIndex() {
    return (this.workspace.getDoc(this.id) as NativeDoc).blockIndex;
  }

  override get root() {
    if (this.blockIndex.readDuringMutation) return super.root;
    const id = this.blockIndex.rootId(this.schema);
    return id ? this.getBlock(id)?.model ?? null : null;
  }

  override getBlocksByFlavour(flavour: string | string[]): Block[] {
    if (this.blockIndex.readDuringMutation) return super.getBlocksByFlavour(flavour);
    const ids = !this.memberships ? this.blockIndex.idsFor(flavour)
      : typeof flavour === 'string' ? Object.keys(this.memberships.get(flavour) ?? {})
      : Object.keys(this.orderedModels).filter(id => flavour.includes(this.getBlock(id)?.flavour ?? ''));
    return ids.flatMap(id => {
      const block = this.getBlock(id);
      return block ? [block] : [];
    });
  }

  override getParent(target: BlockModel | string): BlockModel | null {
    // Yjs observers invalidate indexes after a transaction. Calls inside the
    // mutation itself must still see each change before those observers run.
    if (this.blockIndex.readDuringMutation) return super.getParent(target);
    const id = typeof target === 'string' ? target : target.id;
    const parent = this.blockIndex.parentId(id, this.blockIndex.rootId(this.schema));
    return parent ? this.getModelById(parent) : null;
  }
}

export class NativeStoreContainer {
  private readonly stores = new Map<string, Store>();
  constructor(private readonly doc: Doc) {}

  private key({ readonly, query, id }: GetStoreOptions) {
    return readonly || query ? JSON.stringify({ readonlyKey: readonly?.toString() ?? 'false', query }) : id;
  }

  getStore = ({ readonly, query, provider, extensions, id }: GetStoreOptions = {}) => {
    const key = this.key({ readonly, query, id }) ?? this.doc.workspace.idGenerator();
    const existing = this.stores.get(key);
    if (existing) return existing;
    const docExtension: ExtensionType = { setup: di => { di.addImpl(DocIdentifier, () => this.doc); } };
    const store = new IndexedStore({
      doc: this.doc, readonly, query, provider,
      extensions: [docExtension, ...(extensions ?? [])],
    });
    this.stores.set(key, store);
    return store;
  };

  removeStore = (options: RemoveStoreOptions) => {
    const key = this.key(options);
    if (key) this.stores.delete(key);
  };

  dispose() {
    for (const store of this.stores.values()) store.dispose();
    this.stores.clear();
  }
}
