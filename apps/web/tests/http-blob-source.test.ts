import { BlobEngine, MemoryBlobSource } from '@blocksuite/sync';
import { NoopLogger } from '@blocksuite/affine/global/utils';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { HttpBlobSource } from '../src/blocksuite/http-blob-source';
import { announceAuthChange } from '../src/auth-client';

beforeEach(() => { vi.stubGlobal('location', { origin: 'https://canvas.test' }); announceAuthChange(); });
afterEach(() => vi.unstubAllGlobals());
const bootstrap = () => Response.json({ mode: 'native', csrf: 'fixture-csrf' });

describe('board-scoped browser uploads', () => {
  it('makes native BlobEngine.set wait for the remote upload while retaining a local copy', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn((_request: RequestInfo | URL) => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => typeof input === 'string' && input.endsWith('/auth/bootstrap') ? Promise.resolve(bootstrap()) : fetcher(input));
    const cache = new MemoryBlobSource();
    const remote = new HttpBlobSource('/api/v1/boards/target/blobs', cache);
    const engine = new BlobEngine(remote, [cache], new NoopLogger());
    const blob = new Blob(['image bytes'], { type: 'image/png' });
    let published = false;
    const upload = engine.set('image-key', blob).then(key => { published = true; return key; });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(await cache.get('image-key')).toBe(blob);
    expect(published).toBe(false);
    const request = fetcher.mock.calls[0][0] as Request;
    expect(request.url).toBe('https://canvas.test/api/v1/boards/target/blobs/image-key');
    expect(request.method).toBe('PUT');
    expect(request.headers.get('Content-Type')).toBe('image/png');
    expect(request.headers.get('X-Canvas-CSRF')).toBe('fixture-csrf');
    expect(await request.text()).toBe('image bytes');
    finish(new Response(null, { status: 201 }));
    expect(await upload).toBe('image-key');
    expect(published).toBe(true);
  });

  it('reports a rejected upload and retains bytes without publishing a native source ID', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => typeof input === 'string' && input.endsWith('/auth/bootstrap') ? bootstrap() : new Response(null, { status: 403 })));
    const cache = new MemoryBlobSource();
    const engine = new BlobEngine(new HttpBlobSource('/board/blobs', cache), [cache], new NoopLogger());
    const blob = new Blob(['local bytes']);
    await expect(engine.set('image-key', blob)).rejects.toThrow('Blob upload failed with 403');
    expect(await cache.get('image-key')).toBe(blob);
  });

  it('opens cached images without a network request', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const cache = new MemoryBlobSource();
    const blob = new Blob(['saved bytes']);
    await cache.set('image-key', blob);
    expect(await new HttpBlobSource('/board/blobs', cache).get('image-key')).toBe(blob);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
