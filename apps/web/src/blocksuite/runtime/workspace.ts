import { BlockSuiteError, ErrorCode } from '@blocksuite/affine/global/exceptions';
import { NoopLogger } from '@blocksuite/affine/global/utils';
import {
  AwarenessStore,
  nanoid,
  type Doc,
  type ExtensionType,
  type IdGenerator,
  type Workspace,
} from '@blocksuite/affine/store';
import {
  AwarenessEngine,
  BlobEngine,
  DocEngine,
  MemoryBlobSource,
  NoopDocSource,
  type AwarenessSource,
  type BlobSource,
  type DocSource,
} from '@blocksuite/sync';
import { Subject } from 'rxjs';
import { Awareness } from 'y-protocols/awareness.js';
import * as Y from 'yjs';

import { NativeDoc } from './doc';
import { NativeWorkspaceMeta } from './meta';

export type NativeWorkspaceOptions = {
  id?: string;
  idGenerator?: IdGenerator;
  rootUpdate?: Uint8Array;
  docSources?: { main: DocSource; shadows?: DocSource[] };
  blobSources?: { main: BlobSource; shadows?: BlobSource[] };
  awarenessSources?: AwarenessSource[];
};

/**
 * Product-owned BlockSuite workspace boundary. It keeps the native Yjs root and
 * subdocuments accessible for persistence in Workers and the browser.
 */
export class NativeWorkspace implements Workspace {
  storeExtensions: ExtensionType[] = [];
  readonly awarenessStore: AwarenessStore;
  readonly awarenessSync: AwarenessEngine;
  readonly blobSync: BlobEngine;
  readonly docs = new Map<string, NativeDoc>();
  readonly doc: Y.Doc;
  readonly docSync: DocEngine;
  readonly id: string;
  readonly idGenerator: IdGenerator;
  readonly meta: NativeWorkspaceMeta;
  readonly slots = { docListUpdated: new Subject<void>() };

  constructor({
    id = '',
    idGenerator,
    rootUpdate,
    awarenessSources = [],
    docSources = { main: new NoopDocSource() },
    blobSources = { main: new MemoryBlobSource() },
  }: NativeWorkspaceOptions = {}) {
    this.id = id;
    this.doc = new Y.Doc({ guid: id });
    if (rootUpdate) Y.applyUpdate(this.doc, rootUpdate, 'native-load');
    this.awarenessStore = new AwarenessStore(new Awareness(this.doc));
    this.awarenessSync = new AwarenessEngine(
      this.awarenessStore.awareness,
      awarenessSources
    );
    this.docSync = new DocEngine(
      this.doc,
      docSources.main,
      docSources.shadows ?? [],
      new NoopLogger()
    );
    this.blobSync = new BlobEngine(
      blobSources.main,
      blobSources.shadows ?? [],
      new NoopLogger()
    );
    this.idGenerator = idGenerator ?? nanoid;
    this.meta = new NativeWorkspaceMeta(this.doc);
    this.bindMetaEvents();
  }

  private bindMetaEvents() {
    const addDoc = (docId: string) => {
      if (this.docs.has(docId)) return;
      this.docs.set(
        docId,
        new NativeDoc({
          id: docId,
          workspace: this,
          rootDoc: this.doc,
          awarenessStore: this.awarenessStore,
        })
      );
    };
    this.meta.docMetaAdded.subscribe(addDoc);
    this.meta.docMetaUpdated.subscribe(() => this.slots.docListUpdated.next());
    this.meta.docMetaRemoved.subscribe(id => {
      const doc = this.getBlockCollection(id);
      if (!doc) return;
      this.docs.delete(id);
      doc.remove();
    });
    for (const doc of this.meta.docMetas) addDoc(doc.id);
  }

  canGracefulStop() {
    return this.docSync.canGracefulStop();
  }

  createDoc(docId?: string): Doc {
    const id = docId ?? this.idGenerator();
    if (this.docs.has(id)) {
      throw new BlockSuiteError(ErrorCode.DocCollectionError, 'doc already exists');
    }
    this.meta.addDocMeta({
      id,
      title: '',
      createDate: Date.now(),
      tags: [],
    });
    return this.getDoc(id) as Doc;
  }

  dispose() {
    for (const doc of this.docs.values()) doc.dispose();
    this.meta.dispose();
    this.awarenessStore.destroy();
    this.slots.docListUpdated.complete();
    this.doc.destroy();
    this.docs.clear();
  }

  forceStop() {
    this.docSync.forceStop();
    this.blobSync.stop();
    this.awarenessSync.disconnect();
  }

  getBlockCollection(docId: string) {
    return this.docs.get(docId) ?? null;
  }

  getDoc(docId: string): Doc | null {
    return this.getBlockCollection(docId);
  }

  removeDoc(docId: string) {
    if (!this.meta.getDocMeta(docId)) {
      throw new BlockSuiteError(
        ErrorCode.DocCollectionError,
        `doc meta not found: ${docId}`
      );
    }
    const doc = this.getBlockCollection(docId);
    if (!doc) return;
    doc.dispose();
    this.meta.removeDocMeta(docId);
    this.docs.delete(docId);
  }

  start() {
    this.docSync.start();
    this.blobSync.start();
    this.awarenessSync.connect();
  }

  waitForGracefulStop(abort?: AbortSignal) {
    return this.docSync.waitForGracefulStop(abort);
  }

  waitForSynced() {
    return this.docSync.waitForSynced();
  }
}
