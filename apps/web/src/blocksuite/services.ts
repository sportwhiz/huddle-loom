import type { DocMode } from '@blocksuite/affine/model';
import {
  GeneralSettingSchema,
  type DocModeProvider,
  type EditorSetting,
  type ParseDocUrlService,
} from '@blocksuite/affine/shared/services';
import type { Workspace } from '@blocksuite/affine/store';
import { Signal } from '@preact/signals-core';
import { Subject } from 'rxjs';

import type { WhiteboardEditorElement } from './editor-container';

const DEFAULT_MODE: DocMode = 'edgeless';

export function createDocModeProvider(editor: WhiteboardEditorElement) {
  const changes = new Map<string, Subject<DocMode>>();
  const modes = new Map<string, DocMode>();

  const provider: DocModeProvider = {
    getPrimaryMode: docId => modes.get(docId) ?? DEFAULT_MODE,
    onPrimaryModeChange: (handler, docId) => {
      const subject = changes.get(docId) ?? new Subject<DocMode>();
      changes.set(docId, subject);
      return subject.subscribe(handler);
    },
    getEditorMode: () => editor.mode,
    setEditorMode: mode => editor.switchEditor(mode),
    setPrimaryMode: (mode, docId) => {
      modes.set(docId, mode);
      changes.get(docId)?.next(mode);
    },
    togglePrimaryMode: docId => {
      const mode = provider.getPrimaryMode(docId) === 'page' ? 'edgeless' : 'page';
      provider.setPrimaryMode(mode, docId);
      return mode;
    },
  };

  return provider;
}

export function createEditorSetting() {
  const value = Object.entries(GeneralSettingSchema.shape).reduce(
    (settings, [key, schema]) => {
      settings[key as keyof EditorSetting] = schema.parse(undefined) as never;
      return settings;
    },
    {} as EditorSetting,
  );

  return new Signal<EditorSetting>(value);
}

export function createParseDocUrlService(
  workspace: Workspace,
): ParseDocUrlService {
  return {
    parseDocUrl(url) {
      if (!URL.canParse(url)) {
        return;
      }

      const docId = decodeURIComponent(new URL(url).hash.slice(1));
      return workspace.getDoc(docId) ? { docId } : undefined;
    },
  };
}
