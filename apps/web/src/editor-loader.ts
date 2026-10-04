let pending: Promise<typeof import('./blocksuite/EditorCanvas')> | undefined;

/** Share the route's import with hover/focus preparation and React.lazy. */
export function loadEditor() {
  pending ??= import('./blocksuite/EditorCanvas').catch(error => {
    pending = undefined;
    throw error;
  });
  return pending;
}

export function prepareEditor() {
  void loadEditor().catch(() => undefined);
}
