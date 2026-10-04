import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = new URL(process.argv.slice(2).find(value => /^https?:\/\//u.test(value)) ?? 'http://127.0.0.1:5176');
const ownerHeaders = { 'X-Whiteboard-Dev-Email': 'owner@local.test' };
const formHeaders = { ...ownerHeaders, 'Content-Type': 'application/x-www-form-urlencoded' };
const redirectUri = 'https://client.example/callback';
const resource = new URL('/mcp', base).toString();

function encode(value) { return Buffer.from(value).toString('base64url'); }
function challenge(value) { return createHash('sha256').update(value).digest('base64url'); }
async function json(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}
async function authorize(clientId, scopes) {
  const verifier = encode(randomBytes(48));
  const state = encode(randomBytes(18));
  const url = new URL('/oauth/authorize', base);
  for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes, resource, state, code_challenge: challenge(verifier), code_challenge_method: 'S256' })) url.searchParams.set(key, value);
  // A real client opens consent as browser navigation. SPA asset fallback must
  // not bypass the Worker for these requests.
  const consent = await fetch(url, { headers: { ...ownerHeaders, Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } });
  const html = await consent.text();
  if (!consent.ok) throw new Error(`Consent failed: ${consent.status} ${html}`);
  const requestId = html.match(/name="request_id" value="([^"]+)"/u)?.[1];
  if (!requestId) throw new Error('Consent response did not include request_id');
  const approved = await fetch(new URL('/oauth/authorize', base), { method: 'POST', headers: formHeaders, redirect: 'manual', body: new URLSearchParams({ request_id: requestId, decision: 'allow', resource_mode: 'all' }) });
  if (approved.status !== 302) throw new Error(`Consent approval returned ${approved.status}`);
  const destination = new URL(approved.headers.get('location'));
  if (destination.searchParams.get('state') !== state) throw new Error('OAuth state was not preserved');
  const code = destination.searchParams.get('code');
  if (!code) throw new Error('Authorization code was not issued');
  const exchange = await fetch(new URL('/oauth/token', base), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource }) });
  return json(exchange);
}

const metadata = await json(await fetch(new URL('/.well-known/oauth-protected-resource/mcp', base)));
if (metadata.resource !== resource || !metadata.authorization_servers?.length) throw new Error('Protected resource metadata is incomplete');
const authorization = await json(await fetch(new URL('/.well-known/oauth-authorization-server', base)));
if (!authorization.code_challenge_methods_supported?.includes('S256')) throw new Error('PKCE S256 is not advertised');
const docs = await fetch(new URL('/docs/mcp', base), { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } });
if (!docs.ok || !(await docs.text()).includes('Build a board from a conversation')) throw new Error('MCP documentation navigation was swallowed by the SPA asset fallback');
const invalidRegistration = await fetch(new URL('/oauth/register', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Invalid client', redirect_uris: [`${redirectUri}#fragment`], token_endpoint_auth_method: 'none' }) });
if (invalidRegistration.status !== 400 || (await invalidRegistration.json()).error !== 'invalid_client_metadata') throw new Error('OAuth registration accepted an invalid redirect URI');
const registration = await json(await fetch(new URL('/oauth/register', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'OAuth smoke client', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }) }));
const weakPkce = new URL('/oauth/authorize', base);
for (const [key, value] of Object.entries({ client_id: registration.client_id, redirect_uri: redirectUri, response_type: 'code', scope: 'boards:read', resource, state: 'weak-pkce', code_challenge: 'too-short', code_challenge_method: 'S256' })) weakPkce.searchParams.set(key, value);
const weakPkceResponse = await fetch(weakPkce, { headers: ownerHeaders });
if (weakPkceResponse.status !== 400) throw new Error('OAuth authorization accepted a malformed PKCE challenge');
const original = await authorize(registration.client_id, 'boards:read boards:write collaboration:write boards:export');

const client = new Client({ name: 'oauth-smoke', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { Authorization: `Bearer ${original.access_token}` } } });
await client.connect(transport);
const profile = await client.callTool({ name: 'get_profile', arguments: {} });
if (profile.isError) throw new Error('Authenticated get_profile failed');
const tools = await client.listTools();
const catalogResult = await client.callTool({ name: 'list_workbooks', arguments: {} });
const catalog = JSON.parse(catalogResult.content.find(item => item.type === 'text').text);
const exportResult = await client.callTool({ name: 'export_board', arguments: { boardId: catalog.boards[0].id } });
const exportDetails = JSON.parse(exportResult.content.find(item => item.type === 'text').text);
const archiveResponse = await fetch(exportDetails.downloadUrl, { headers: { Authorization: `Bearer ${original.access_token}` } });
if (!archiveResponse.ok || archiveResponse.headers.get('content-type') !== 'application/vnd.personal-whiteboard+json') throw new Error(`OAuth archive download failed: ${archiveResponse.status}`);
const archive = await archiveResponse.json();
if (archive.format !== 'cloudflare-whiteboard/archive' || archive.version !== 1) throw new Error('OAuth archive download returned an invalid archive');
const limited = await authorize(registration.client_id, 'boards:read');
const deniedArchive = await fetch(exportDetails.downloadUrl, { headers: { Authorization: `Bearer ${limited.access_token}` } });
const deniedArchiveBody = await deniedArchive.json();
if (deniedArchive.status !== 403 || deniedArchiveBody.code !== 'INSUFFICIENT_SCOPE') throw new Error('Archive download accepted a token without boards:export');
await fetch(new URL('/oauth/revoke', base), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: limited.access_token }) });

const collaborationLimited = await authorize(registration.client_id, 'boards:read collaboration:write');
const collaborationLimitedClient = new Client({ name: 'oauth-collaboration-scope-smoke', version: '0.1.0' });
const collaborationLimitedTransport = new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { Authorization: `Bearer ${collaborationLimited.access_token}` } } });
await collaborationLimitedClient.connect(collaborationLimitedTransport);
const deniedReveal = await collaborationLimitedClient.callTool({ name: 'collaboration_command', arguments: { boardId: catalog.boards[0].id, operationId: `denied-reveal-${Date.now()}`, action: 'reveal_brainstorm', values: {} } });
const deniedRevealText = deniedReveal.content.find(item => item.type === 'text')?.text ?? '';
if (!deniedReveal.isError || !deniedRevealText.includes('boards:write')) throw new Error('Brainstorm reveal accepted a token without boards:write');
const deniedOverride = await collaborationLimitedClient.callTool({ name: 'collaboration_command', arguments: { boardId: catalog.boards[0].id, operationId: `denied-override-${Date.now()}`, action: 'raise_hand', values: { action: 'reveal_brainstorm' } } });
if (!deniedOverride.isError || !deniedOverride.content.some(item => item.type === 'text' && item.text.includes('Reserved'))) throw new Error('Nested collaboration values overrode the scope-checked action');
const deniedUpload = await collaborationLimitedClient.callTool({ name: 'upload_image', arguments: { boardId: catalog.boards[0].id, contentType: 'image/png', data: btoa('invalid') } });
if (!deniedUpload.isError || !deniedUpload.content.some(item => item.type === 'text' && item.text.includes('boards:write'))) throw new Error('Image upload accepted a read/collaboration token');
await collaborationLimitedClient.close();
await fetch(new URL('/oauth/revoke', base), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: collaborationLimited.access_token }) });
await client.close();

const refresh = await json(await fetch(new URL('/oauth/token', base), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: registration.client_id, refresh_token: original.refresh_token, resource }) }));
const reused = await fetch(new URL('/oauth/token', base), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: registration.client_id, refresh_token: original.refresh_token, resource }) });
if (reused.status !== 400 || (await reused.json()).error !== 'invalid_grant') throw new Error('Rotated refresh token was reusable');
await fetch(new URL('/oauth/revoke', base), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refresh.access_token }) });
const revoked = await fetch(resource, { method: 'POST', headers: { Authorization: `Bearer ${refresh.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'revocation-check', version: '1' } } }) });
if (revoked.status !== 401 || !revoked.headers.get('www-authenticate')?.includes('resource_metadata=')) throw new Error('Revoked token did not produce an OAuth discovery challenge');

process.stdout.write(`${JSON.stringify({ endpoint: resource, clientId: registration.client_id, tools: tools.tools.map(tool => tool.name), pkce: true, oauthArchiveDownload: true, brainstormRevealScope: true, refreshRotation: true, revocation: true }, null, 2)}\n`);
