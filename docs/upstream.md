# Upstream projects

Open Whiteboard uses BlockSuite 0.22.4 for its editor and native board model. The complete application includes our own Studio, accounts, collaboration controls, MCP authoring services, and Cloudflare and Node hosting adapters.

BlockSuite source packages are compiled through Vite and esbuild. Yjs is pinned to one runtime version to avoid mixed constructors in board state. The server authoring path uses the native schema without loading the browser editor.

Local adaptations retain their upstream origin in source headers: `apps/web/src/blocksuite/runtime/store-container.ts`, `apps/web/src/blocksuite/lazy-highlighter.ts`, and `apps/web/src/blocksuite/embed-branding.ts`. The highlighter defers syntax-highlighting work so it does not delay ordinary whiteboard loading. The embed adaptation selects supported providers and uses neutral placeholder text.

Authentication uses Better Auth; protocol handling uses the Model Context Protocol SDK. React, Lit, Yjs, and other packages retain their own licenses. See [Third-party notices](../THIRD_PARTY_NOTICES.md) for exact versions, full license files, corresponding source, and fonts.

Open Whiteboard is independently maintained. Upstream names describe the libraries used here and do not imply endorsement.
