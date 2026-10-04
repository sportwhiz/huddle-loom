import { afterEach, describe, it, expect, vi } from "vitest";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
describe("browser authentication transitions", () => {
  it("announces provider/passkey identity changes without broadcasting refresh loops", async () => {
    vi.stubGlobal("location", new URL("https://canvas.example.com"));
    const send = vi.fn();
    let receive: (event: { data: unknown }) => void = () => {};
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        postMessage = send;
        addEventListener(_name: string, handler: typeof receive) {
          receive = handler;
        }
      },
    );
    let id = "user:first";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          mode: "native",
          configured: true,
          setup: false,
          cacheNamespace: "fixture",
          user: { id },
          account: { authVersion: 1, status: "active", assurance: "strong" },
        }),
      ),
    );
    const auth = await import("./auth-client");
    const listener = vi.fn();
    auth.subscribeAuth(listener);
    await auth.bootstrapAuth();
    const first = send.mock.calls[0][0];
    receive({ data: first });
    await auth.bootstrapAuth(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
    id = "user:second";
    await auth.bootstrapAuth(true);
    expect(send).toHaveBeenCalledTimes(2);
    const second = send.mock.calls[1][0];
    expect(second).not.toEqual(first);
    receive({ data: second });
    expect(listener).not.toHaveBeenCalled();
    receive({ data: first });
    expect(listener).toHaveBeenCalledOnce();
    expect(auth.authSnapshot()).toBeUndefined();
  });
  it("keeps the sign-in screen mounted while a second-factor cookie is pending", async () => {
    vi.stubGlobal("location", new URL("https://canvas.example.com"));
    vi.stubGlobal("BroadcastChannel", undefined);
    let challenge = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : input.toString();
        return Response.json(
          url.includes("/auth/bootstrap")
            ? {
                mode: "native",
                configured: true,
                setup: false,
                csrf: "fixture-csrf",
              }
            : challenge
              ? { twoFactorRedirect: true }
              : { token: "fixture-token" },
        );
      }),
    );
    const auth = await import("./auth-client");
    const listener = vi.fn();
    auth.subscribeAuth(listener);
    await auth.bootstrapAuth();
    const response = await auth.api("/api/auth/sign-in/email", {
      email: "fixture@example.invalid",
      password: "fixture",
    });
    expect(response.twoFactorRedirect).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    expect(auth.authSnapshot()).toBeUndefined();
    challenge = false;
    await auth.api("/api/auth/sign-in/email", {
      email: "fixture@example.invalid",
      password: "fixture",
    });
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('anonymous board isolation in the browser client',()=>{
 it('uses guest headers only for the shared board and keeps recovery separate from signed-in accounts',async()=>{
  vi.stubGlobal('location',new URL('https://app.example/guest/board%3Ashared'));
  vi.stubGlobal('BroadcastChannel',undefined);
  const dispatch=vi.fn();vi.stubGlobal('window',{dispatchEvent:dispatch});
  const request=vi.fn(async(input:Request|string)=>Response.json((typeof input==='string'?input:input.url).endsWith('/commands')?{ok:true}:{mode:'native',configured:true,setup:false,csrf:'account-csrf',cacheNamespace:'account',user:{id:'owner'},account:{authVersion:1,status:'active',assurance:'strong'}}));
  vi.stubGlobal('fetch',request);
  const guest=await import('./guest-client');const auth=await import('./auth-client');
  guest.setGuestSession({boardId:'board:shared',linkId:'link',sessionId:'anonymous-session',expiresAt:'2099-01-01',csrf:'guest-csrf',role:'editor',title:'Shared',user:{id:'guest',name:'Visitor',color:'#123'}});
  await auth.apiFetch('/api/v1/boards/board%3Ashared/commands',{method:'POST',body:'{}'});
  expect((request.mock.calls[0][0] as Request).headers.get('X-Huddle-Guest')).toBe('board:shared');
  expect((request.mock.calls[0][0] as Request).headers.get('X-Huddle-Guest-Link')).toBe('link');
  expect((request.mock.calls[0][0] as Request).headers.get('X-Huddle-Guest-CSRF')).toBe('guest-csrf');
  expect(auth.cacheIdentity('guest')).toContain('anonymous-session');expect(()=>auth.cacheIdentity('owner')).toThrow('another session');
  await auth.apiFetch('/api/v1/workspace');expect((request.mock.calls[1][0] as Request).headers.has('X-Huddle-Guest')).toBe(false);
  vi.stubGlobal('location',new URL('https://app.example/'));await auth.bootstrapAuth(true);
  expect(auth.cacheIdentity('owner')).not.toContain('anonymous-session');expect(guest.guestSession()).toBeUndefined();
 });
 it.each([401, 403])('stops requests and preserves the recovery identity when a guest session ends (%s)',async status=>{
  vi.stubGlobal('location',new URL('https://app.example/guest/board%3Ashared'));
  vi.stubGlobal('BroadcastChannel',undefined);
  const dispatch=vi.fn();vi.stubGlobal('window',{dispatchEvent:dispatch});
  const request=vi.fn(async()=>Response.json({error:'Session changed',code:status===403?'CSRF_REJECTED':'GUEST_ACCESS_ENDED'},{status}));
  vi.stubGlobal('fetch',request);
  const guest=await import('./guest-client');const auth=await import('./auth-client');
  const session={boardId:'board:shared',linkId:'link',sessionId:'original-session',expiresAt:'2099-01-01',csrf:'original-csrf',role:'editor',title:'Shared',user:{id:'original-guest',name:'Visitor',color:'#123'}};
  guest.setGuestSession(session);
  await auth.apiFetch('/api/v1/boards/board%3Ashared/commands',{method:'POST',body:'{}'});
  expect(dispatch).toHaveBeenCalledOnce();
  expect(guest.guestEndedReason()).toBeTruthy();
  expect(auth.cacheIdentity('original-guest')).toContain('original-session');
  expect((await auth.apiFetch('/api/v1/boards/board%3Ashared/commands',{method:'POST',body:'{}'})).status).toBe(401);
  expect(request).toHaveBeenCalledOnce();
  guest.setGuestSession({...session,sessionId:'new-session'});
  expect(guest.guestEndedReason()).toBeUndefined();
 });
 it('does not end a valid guest session for an ordinary permission denial',async()=>{
  vi.stubGlobal('location',new URL('https://app.example/guest/board%3Ashared'));
  vi.stubGlobal('BroadcastChannel',undefined);
  const dispatch=vi.fn();vi.stubGlobal('window',{dispatchEvent:dispatch});
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:'Cannot edit',code:'FORBIDDEN'},{status:403})));
  const guest=await import('./guest-client');const auth=await import('./auth-client');
  guest.setGuestSession({boardId:'board:shared',linkId:'link',sessionId:'viewer-session',expiresAt:'2099-01-01',csrf:'guest-csrf',role:'viewer',title:'Shared',user:{id:'guest',name:'Visitor',color:'#123'}});
  expect((await auth.apiFetch('/api/v1/boards/board%3Ashared/commands',{method:'POST',body:'{}'})).status).toBe(403);
  expect(dispatch).not.toHaveBeenCalled();expect(guest.guestEndedReason()).toBeUndefined();
 });
});
