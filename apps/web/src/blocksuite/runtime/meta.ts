import {
  createYProxy,
  type DocMeta,
  type DocsPropertiesMeta,
  type WorkspaceMeta,
} from '@blocksuite/affine/store';
import { Subject } from 'rxjs';
import type * as Y from 'yjs';

type WorkspaceMetaState = {
  pages?: unknown[];
  properties?: DocsPropertiesMeta;
  name?: string;
  avatar?: string;
};

export class NativeWorkspaceMeta implements WorkspaceMeta {
  private readonly proxy: WorkspaceMetaState;
  private readonly yMap: Y.Map<WorkspaceMetaState[keyof WorkspaceMetaState]>;
  private previousDocs = new Set<string>();

  readonly doc: Y.Doc;
  readonly id = 'meta';
  readonly docMetaAdded = new Subject<string>();
  readonly docMetaRemoved = new Subject<string>();
  readonly docMetaUpdated = new Subject<void>();

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.yMap = doc.getMap(this.id) as Y.Map<
      WorkspaceMetaState[keyof WorkspaceMetaState]
    >;
    this.proxy = createYProxy(this.yMap);
    this.yMap.observeDeep(this.handleMetaEvents);
  }

  get docMetas() {
    return (this.proxy.pages ?? []) as DocMeta[];
  }

  get docs() {
    return this.proxy.pages;
  }

  get properties(): DocsPropertiesMeta {
    return this.proxy.properties ?? { tags: { options: [] } };
  }

  get yDocs() {
    return this.yMap.get('pages') as unknown as Y.Array<unknown>;
  }

  private readonly handleMetaEvents = (
    events: Y.YEvent<Y.Array<unknown> | Y.Text | Y.Map<unknown>>[]
  ) => {
    const changed = events.some(event => {
      const mapKeyChanged =
        event.target === this.yMap && event.changes.keys.has('pages');
      return (
        event.target === this.yDocs ||
        event.target.parent === this.yDocs ||
        mapKeyChanged
      );
    });
    if (!changed) return;

    const next = new Set<string>();
    for (const doc of this.docMetas) {
      if (!this.previousDocs.has(doc.id)) this.docMetaAdded.next(doc.id);
      next.add(doc.id);
    }
    for (const id of this.previousDocs) {
      if (!next.has(id)) this.docMetaRemoved.next(id);
    }
    this.previousDocs = next;
    this.docMetaUpdated.next();
  };

  addDocMeta(doc: DocMeta, index?: number) {
    this.doc.transact(() => {
      if (!this.docs) return;
      const docs = this.docs as unknown[];
      index === undefined ? docs.push(doc) : docs.splice(index, 0, doc);
    }, this.doc.clientID);
  }

  getDocMeta(id: string) {
    return this.docMetas.find(doc => doc.id === id);
  }

  initialize() {
    if (!this.proxy.pages) this.proxy.pages = [];
  }

  removeDocMeta(id: string) {
    const index = this.docMetas.findIndex(doc => doc.id === id);
    if (!this.docs || index < 0) return;
    this.doc.transact(() => this.docs?.splice(index, 1), this.doc.clientID);
  }

  setDocMeta(id: string, props: Partial<DocMeta>) {
    const index = this.docMetas.findIndex(doc => doc.id === id);
    if (!this.docs || index < 0) return;
    this.doc.transact(() => {
      const doc = this.docs?.[index] as Record<string, unknown> | undefined;
      if (doc) Object.assign(doc, props);
    }, this.doc.clientID);
  }

  setProperties(meta: DocsPropertiesMeta) {
    this.proxy.properties = meta;
    this.docMetaUpdated.next();
  }

  dispose() {
    this.yMap.unobserveDeep(this.handleMetaEvents);
    this.docMetaAdded.complete();
    this.docMetaRemoved.complete();
    this.docMetaUpdated.complete();
  }
}
