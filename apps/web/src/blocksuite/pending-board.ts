import type { NativeBoardSnapshot } from './runtime/snapshot';

export type PendingBoard = {
  title?: string;
  snapshot: NativeBoardSnapshot;
  baseRevision: number;
  documentEpoch: string;
  generation: number;
  savedAt: string;
};

export type PendingUpdateBatch = {
  key: string;
  boardKey: string;
  operationId: string;
  documentEpoch: string;
  updates: Array<{ docId: string | null; update: string }>;
  createdAt: string;
};

const DATABASE = 'personal-whiteboard';
const STORE = 'pending-boards';
const OUTBOX = 'pending-update-batches';

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.addEventListener('upgradeneeded', () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE);
      }
      if (!database.objectStoreNames.contains(OUTBOX)) {
        const outbox = database.createObjectStore(OUTBOX, { keyPath: 'key' });
        outbox.createIndex('boardKey', 'boardKey');
      }
    });
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error));
  });
}

async function transact<T>(
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
) {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      let result: T;
      request.addEventListener('success', () => { result = request.result; });
      request.addEventListener('error', () => reject(request.error));
      transaction.addEventListener('complete', () => resolve(result));
      transaction.addEventListener('abort', () => reject(transaction.error));
    });
  } finally {
    database.close();
  }
}

export function readPendingBoard(boardId: string) {
  return transact<PendingBoard | undefined>(STORE, 'readonly', store => store.get(boardId));
}

export function writePendingBoard(boardId: string, pending: PendingBoard) {
  return transact<IDBValidKey>(STORE, 'readwrite', store => store.put(pending, boardId));
}

export function enqueueUpdateBatch(batch: PendingUpdateBatch) {
  return transact<IDBValidKey>(OUTBOX, 'readwrite', store => store.put(batch));
}

export function listUpdateBatches(boardKey: string) {
  return transact<PendingUpdateBatch[]>(OUTBOX, 'readonly', store =>
    store.index('boardKey').getAll(IDBKeyRange.only(boardKey))
  ).then(items => items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
}

export function acknowledgeUpdateBatch(key: string) {
  return transact<undefined>(OUTBOX, 'readwrite', store => store.delete(key) as IDBRequest<undefined>);
}

export async function clearPendingBoard(boardId: string, generation: number) {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const read = store.get(boardId) as IDBRequest<PendingBoard | undefined>;
      read.addEventListener('success', () => {
        if (read.result?.generation === generation) store.delete(boardId);
      });
      read.addEventListener('error', () => reject(read.error));
      transaction.addEventListener('complete', () => resolve());
      transaction.addEventListener('abort', () => reject(transaction.error));
    });
  } finally {
    database.close();
  }
}

export async function discardPendingBoard(boardKey: string) {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([STORE, OUTBOX], 'readwrite');
      transaction.objectStore(STORE).delete(boardKey);
      const cursor = transaction.objectStore(OUTBOX).index('boardKey').openKeyCursor(IDBKeyRange.only(boardKey));
      cursor.addEventListener('success', () => {
        if (!cursor.result) return;
        transaction.objectStore(OUTBOX).delete(cursor.result.primaryKey);
        cursor.result.continue();
      });
      cursor.addEventListener('error', () => reject(cursor.error));
      transaction.addEventListener('complete', () => resolve());
      transaction.addEventListener('abort', () => reject(transaction.error));
    });
  } finally {
    database.close();
  }
}

export type AccountDraft = { key:string; pending?:PendingBoard; batches:PendingUpdateBatch[] };

/** Remove only the version the user reviewed. Another tab may have newer edits. */
export async function discardReviewedDraft(draft: AccountDraft) {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([STORE, OUTBOX], 'readwrite');
      const store = transaction.objectStore(STORE);
      const read = store.get(draft.key) as IDBRequest<PendingBoard | undefined>;
      read.onsuccess = () => {
        const current = read.result;
        if (current && draft.pending && current.generation === draft.pending.generation && current.savedAt === draft.pending.savedAt) store.delete(draft.key);
      };
      for (const batch of draft.batches) transaction.objectStore(OUTBOX).delete(batch.key);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { database.close(); }
}
export function accountDraftPrefix(namespace:string,userId:string) {
  return `${encodeURIComponent(namespace)}:${encodeURIComponent(userId)}:`;
}
export async function listAccountDrafts(namespace:string,userId:string):Promise<AccountDraft[]> {
  const database=await openDatabase();
  try {
    return await new Promise((resolve,reject)=>{
      const transaction=database.transaction([STORE,OUTBOX],'readonly');
      const drafts=new Map<string,AccountDraft>();
      const prefixes=[accountDraftPrefix(namespace,userId),`${userId}:board:`];
      for(const prefix of prefixes){
        const range=IDBKeyRange.bound(prefix,`${prefix}\uffff`);
        const snapshots=transaction.objectStore(STORE).openCursor(range);
        snapshots.onsuccess=()=>{const cursor=snapshots.result;if(!cursor)return;const key=String(cursor.key);const item=drafts.get(key)??{key,batches:[]};item.pending=cursor.value;drafts.set(key,item);cursor.continue();};
        const batches=transaction.objectStore(OUTBOX).index('boardKey').openCursor(range);
        batches.onsuccess=()=>{const cursor=batches.result;if(!cursor)return;const batch=cursor.value as PendingUpdateBatch;const item=drafts.get(batch.boardKey)??{key:batch.boardKey,batches:[]};item.batches.push(batch);drafts.set(item.key,item);cursor.continue();};
      }
      transaction.oncomplete=()=>resolve([...drafts.values()]);transaction.onabort=()=>reject(transaction.error);transaction.onerror=()=>reject(transaction.error);
    });
  } finally {database.close();}
}
