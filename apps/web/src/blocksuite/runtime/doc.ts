import {
  type AwarenessStore,
  type Doc,
  type GetStoreOptions,
  type Workspace,
  type YBlock,
} from '@blocksuite/affine/store';
import * as Y from 'yjs';

import type { NativeWorkspace } from './workspace';
import { NativeBlockIndex } from './block-index';
import { NativeStoreContainer } from './store-container';

type NativeDocOptions = {
  id: string;
  workspace: Workspace;
  rootDoc: Y.Doc;
  awarenessStore: AwarenessStore;
};

export class NativeDoc implements Doc {
  private readonly workspaceRef: Workspace;
  private readonly storeContainer: NativeStoreContainer;
  private loadedState = false;
  private readyState = false;

  protected readonly ySpaceDoc: Y.Doc;
  protected readonly yBlockMap: Y.Map<YBlock>;

  readonly awarenessStore: AwarenessStore;
  readonly id: string;
  readonly rootDoc: Y.Doc;
  readonly blockIndex: NativeBlockIndex;

  constructor({ id, workspace, rootDoc, awarenessStore }: NativeDocOptions) {
    this.id = id;
    this.rootDoc = rootDoc;
    this.awarenessStore = awarenessStore;
    this.workspaceRef = workspace;
    this.ySpaceDoc = this.initializeSubdoc();
    this.yBlockMap = this.ySpaceDoc.getMap('blocks');
    this.blockIndex = new NativeBlockIndex(this.yBlockMap);
    this.storeContainer = new NativeStoreContainer(this);
  }

  private initializeSubdoc() {
    const spaces = this.rootDoc.getMap<Y.Doc>('spaces');
    const existing = spaces.get(this.id);
    if (existing) {
      this.rootDoc.on('subdocs', this.handleSubdocLoad);
      return existing;
    }
    const created = new Y.Doc({ guid: this.id });
    spaces.set(this.id, created);
    this.loadedState = true;
    return created;
  }

  private readonly handleSubdocLoad = ({ loaded }: { loaded: Set<Y.Doc> }) => {
    if (![...loaded].some(doc => doc.guid === this.ySpaceDoc.guid)) return;
    this.rootDoc.off('subdocs', this.handleSubdocLoad);
    this.loadedState = true;
  };

  get blobSync() {
    return this.workspace.blobSync;
  }

  get workspace() {
    return this.workspaceRef;
  }

  get isEmpty() {
    return this.yBlockMap.size === 0;
  }

  get loaded() {
    return this.loadedState;
  }

  get meta() {
    return this.workspace.meta.getDocMeta(this.id);
  }

  get ready() {
    return this.readyState;
  }

  get spaceDoc() {
    return this.ySpaceDoc;
  }

  get yBlocks() {
    return this.yBlockMap;
  }

  clear() {
    this.yBlockMap.clear();
  }

  get removeStore() {
    return this.storeContainer.removeStore;
  }

  getStore({ readonly, query, provider, extensions, id }: GetStoreOptions = {}) {
    const workspaceExtensions = (this.workspace as NativeWorkspace).storeExtensions;
    const storeId =
      id ?? (readonly !== undefined || query ? undefined : this.spaceDoc.guid);
    return this.storeContainer.getStore({
      id: storeId,
      readonly,
      query,
      provider,
      extensions: workspaceExtensions.concat(extensions ?? []),
    });
  }

  load(init?: () => void) {
    if (this.ready) return this;
    this.ySpaceDoc.load();
    init?.();
    this.readyState = true;
    return this;
  }

  remove() {
    this.ySpaceDoc.destroy();
    this.loadedState = false;
    this.rootDoc.getMap('spaces').delete(this.id);
  }

  dispose() {
    this.storeContainer.dispose();
    this.blockIndex.dispose();
  }
}
