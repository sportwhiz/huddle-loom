import { getInternalStoreExtensions } from '@blocksuite/affine/extensions/store';
import type { ExtensionType } from '@blocksuite/affine/store';

export function getStoreExtensions() {
  const extensions = new Set<ExtensionType>();
  const context = {
    scope: 'store' as const,
    register(value: ExtensionType | ExtensionType[]) {
      for (const extension of Array.isArray(value) ? value : [value]) {
        extensions.add(extension);
      }
      return context;
    },
  };

  for (const Provider of getInternalStoreExtensions()) {
    new Provider().setup(context);
  }
  return [...extensions];
}
