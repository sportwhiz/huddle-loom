import { apiFetch } from "../auth-client";
import type { BlobSource } from '@blocksuite/sync';

type BlobList = { keys: string[] };

export class HttpBlobSource implements BlobSource {
  readonly name = 'cloudflare-r2';
  readonly readonly = false;

  constructor(
    private readonly endpoint = '/api/v1/blobs',
    private readonly cache?: BlobSource
  ) {}

  async delete(key: string) {
    const response = await apiFetch(`${this.endpoint}/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Blob delete failed with ${response.status}`);
    }
  }

  async get(key: string) {
    const cached = await this.cache?.get(key);
    if (cached) return cached;
    const response = await apiFetch(`${this.endpoint}/${encodeURIComponent(key)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Blob download failed with ${response.status}`);
    const value = await response.blob();
    await this.cache?.set(key, value);
    return value;
  }

  async list() {
    const response = await apiFetch(this.endpoint);
    if (!response.ok) throw new Error(`Blob listing failed with ${response.status}`);
    const remoteKeys = ((await response.json()) as BlobList).keys;
    if (!this.cache) return remoteKeys;
    const localKeys = new Set(await this.cache.list());
    return remoteKeys.filter(key => localKeys.has(key));
  }

  async set(key: string, value: Blob) {
    // Keep a local copy, but publish a native reference only after the board-scoped upload succeeds.
    await this.cache?.set(key, value);
    const response = await apiFetch(`${this.endpoint}/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': value.type || 'application/octet-stream' },
      body: value,
    });
    if (!response.ok) throw new Error(`Blob upload failed with ${response.status}`);
    return key;
  }
}
