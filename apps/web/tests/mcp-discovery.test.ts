import { describe, expect, it } from 'vitest';
import type { Principal } from '../src/collaboration-types';
import { handleMcpRequest } from '../src/mcp.server';
import { anchor } from '../src/native-operation-schema';

const principal = { id: 'discovery-test', name: 'Discovery test', authentication: 'development' } as Principal;
const env = {} as Parameters<typeof handleMcpRequest>[1];

async function rpc(method: string, params: Record<string, unknown> = {}, protocolVersion = '2025-06-18') {
  return handleMcpRequest(new Request('https://studio.example/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': protocolVersion,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), env, principal);
}

function checkArraySchemas(value: unknown) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(checkArraySchemas);
    return;
  }
  const schema = value as Record<string, unknown>;
  if (schema.type === 'array') {
    expect(schema.items).toBeDefined();
    expect(Array.isArray(schema.items)).toBe(false);
  }
  Object.values(schema).forEach(checkArraySchemas);
}

describe('MCP discovery wire format', () => {
  it.each(['2025-06-18', '2025-11-25'])('initializes and lists every tool with homogeneous array schemas (%s)', async protocolVersion => {
    const initialized = await rpc('initialize', {
      protocolVersion, capabilities: {},
      clientInfo: { name: 'discovery-test', version: '1.0.0' },
    }, protocolVersion);
    expect(initialized.status).toBe(200);
    expect((await initialized.json()).result.capabilities.tools).toBeDefined();
    // Each request gets a fresh stateless transport, as it does on Workers.
    const response = await rpc('tools/list', {}, protocolVersion);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.error).toBeUndefined();
    expect(payload.result.tools).toHaveLength(21);
    expect(payload.result.tools.map((tool: { name: string }) => tool.name))
      .toEqual(expect.arrayContaining(['batch_edit_board', 'create_workflow', 'compose_board', 'get_profile']));
    for (const tool of payload.result.tools) checkArraySchemas(tool.inputSchema);
    const workflow = payload.result.tools.find((tool: { name: string }) => tool.name === 'create_workflow');
    const coordinate = workflow.inputSchema.properties.edges.items.properties.sourceAnchor.anyOf[1];
    expect(coordinate).toMatchObject({
      type: 'array', minItems: 2, maxItems: 2,
      items: { type: 'number', minimum: 0, maximum: 1 },
    });
  });

  it('keeps named anchors and exactly two bounded finite coordinates', () => {
    for (const value of ['top', 'right', 'bottom', 'left', [0, 1], [0.5, 0.5]])
      expect(anchor.parse(value)).toEqual(value);
    for (const value of [[], [0], [0, 0, 0], [-0.1, 0], [0, 1.1], [NaN, 0], [Infinity, 0], ['0', 1], 'center'])
      expect(anchor.safeParse(value).success).toBe(false);
  });
});
