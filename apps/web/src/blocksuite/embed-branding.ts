// Adaptations to BlockSuite 0.22.4's embed provider registry and idle card.
// Upstream source and notices: https://github.com/toeverything/blocksuite/tree/v0.22.4
// The transformations below are distributed with Huddle Loom's corresponding source.
export function isEmbedAdaptation(sourceId: string): boolean {
  return sourceId.endsWith('/embed-iframe-block/configs/providers/index.ts') ||
    sourceId.endsWith('/embed-iframe-block/components/embed-iframe-idle-card.ts');
}

export function adaptEmbedSource(code: string, sourceId: string): string {
  if (sourceId.endsWith('/embed-iframe-block/configs/providers/index.ts')) {
    // Keep supported providers explicit; new upstream integrations need review.
    const providers = [
      ['Spotify', 'spotify'],
      ['GoogleDrive', 'google-drive'],
      ['Excalidraw', 'excalidraw'],
      ['GoogleDocs', 'google-docs'],
      ['Generic', 'generic'],
    ];
    return providers.map(([name, file]) =>
      `import { ${name}EmbedConfig } from './${file}';`
    ).join('\n') + '\nexport const EmbedIframeConfigExtensions = [\n' +
      providers.map(([name]) => `  ${name}EmbedConfig,`).join('\n') + '\n];\n';
  }
  if (sourceId.endsWith('/embed-iframe-block/components/embed-iframe-idle-card.ts')) {
    return code.replace(/Embed anything \([^\r\n]*\)/u,
      'Embed a document, song, or webpage');
  }
  return code;
}
