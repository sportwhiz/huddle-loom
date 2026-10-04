import * as Y from 'yjs';

import type { ExtensionType } from '@blocksuite/affine/store';

import {
  NativeWorkspace,
  type NativeWorkspaceOptions,
} from './workspace';

export const NATIVE_SNAPSHOT_VERSION = 1;

export type NativeBoardSnapshot = {
  format: 'cloudflare-whiteboard/native';
  version: typeof NATIVE_SNAPSHOT_VERSION;
  workspaceId: string;
  root: string;
  docs: Record<string, string>;
};

export function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export type NativeUpdate = { docId: string | null; update: string };

export type NativeStateVectors = { root: string; docs: Record<string, string> };

export function captureNativeStateVectors(workspace: NativeWorkspace): NativeStateVectors {
  return {
    root: toBase64(Y.encodeStateVector(workspace.doc)),
    docs: Object.fromEntries([...workspace.docs].map(([id, doc]) => [id, toBase64(Y.encodeStateVector(doc.spaceDoc))])),
  };
}

export function applyNativeUpdates(snapshot: NativeBoardSnapshot, updates: NativeUpdate[]) {
  if (snapshot.format !== 'cloudflare-whiteboard/native' || snapshot.version !== NATIVE_SNAPSHOT_VERSION) {
    throw new Error('Unsupported native board snapshot');
  }
  const next: NativeBoardSnapshot = { ...snapshot, docs: { ...snapshot.docs } };
  const rootUpdates = updates.filter(item => item.docId === null);
  if (rootUpdates.length) {
    const root = new Y.Doc({ guid: snapshot.workspaceId });
    Y.applyUpdate(root, fromBase64(snapshot.root), 'native-load');
    for (const item of rootUpdates) Y.applyUpdate(root, fromBase64(item.update), 'native-remote');
    next.root = toBase64(Y.encodeStateAsUpdate(root));
    root.destroy();
  }
  const byDoc = new Map<string, string[]>();
  for (const item of updates) {
    if (item.docId === null) continue;
    const list = byDoc.get(item.docId) ?? [];
    list.push(item.update);
    byDoc.set(item.docId, list);
  }
  for (const [docId, encoded] of byDoc) {
    const doc = new Y.Doc({ guid: docId });
    const current = next.docs[docId];
    if (current) Y.applyUpdate(doc, fromBase64(current), 'native-load');
    for (const update of encoded) Y.applyUpdate(doc, fromBase64(update), 'native-remote');
    next.docs[docId] = toBase64(Y.encodeStateAsUpdate(doc));
    doc.destroy();
  }
  return next;
}

export function mergeNativeUpdates(workspace: NativeWorkspace, updates: NativeUpdate[]) {
  for (const item of updates) {
    if (item.docId === null) {
      Y.applyUpdate(workspace.doc, fromBase64(item.update), 'native-remote');
      continue;
    }
    const doc = workspace.getBlockCollection(item.docId);
    if (!doc) throw new Error(`Update doc metadata missing: ${item.docId}`);
    Y.applyUpdate(doc.spaceDoc, fromBase64(item.update), 'native-remote');
    doc.load();
  }
}

export function mergeNativeSnapshot(
  workspace: NativeWorkspace,
  snapshot: NativeBoardSnapshot
) {
  if (
    snapshot.format !== 'cloudflare-whiteboard/native' ||
    snapshot.version !== NATIVE_SNAPSHOT_VERSION
  ) {
    throw new Error('Unsupported native board snapshot');
  }
  Y.applyUpdate(workspace.doc, fromBase64(snapshot.root), 'native-remote');
  for (const [id, update] of Object.entries(snapshot.docs)) {
    const doc = workspace.getBlockCollection(id);
    if (!doc) throw new Error(`Snapshot doc metadata missing: ${id}`);
    Y.applyUpdate(doc.spaceDoc, fromBase64(update), 'native-remote');
    doc.load();
  }
}

export function captureNativeSnapshot(
  workspace: NativeWorkspace
): NativeBoardSnapshot {
  return {
    format: 'cloudflare-whiteboard/native',
    version: NATIVE_SNAPSHOT_VERSION,
    workspaceId: workspace.id,
    root: toBase64(Y.encodeStateAsUpdate(workspace.doc)),
    docs: Object.fromEntries(
      [...workspace.docs].map(([id, doc]) => [
        id,
        toBase64(Y.encodeStateAsUpdate(doc.spaceDoc)),
      ])
    ),
  };
}

export function restoreNativeSnapshot(
  snapshot: NativeBoardSnapshot,
  storeExtensions: ExtensionType[] = [],
  workspaceOptions: Omit<NativeWorkspaceOptions, 'id' | 'rootUpdate'> = {}
) {
  if (
    snapshot.format !== 'cloudflare-whiteboard/native' ||
    snapshot.version !== NATIVE_SNAPSHOT_VERSION
  ) {
    throw new Error('Unsupported native board snapshot');
  }

  const workspace = new NativeWorkspace({
    ...workspaceOptions,
    id: snapshot.workspaceId,
    rootUpdate: fromBase64(snapshot.root),
  });
  workspace.storeExtensions = storeExtensions;
  workspace.meta.initialize();

  mergeNativeSnapshot(workspace, snapshot);
  return workspace;
}
