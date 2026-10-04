import { ViewExtensionManager } from '@blocksuite/affine/ext-loader';
import { getInternalViewExtensions } from '@blocksuite/affine/extensions/view';

const viewManager = new ViewExtensionManager(getInternalViewExtensions());

export function getViewExtensions(mode: 'page' | 'edgeless') {
  return viewManager.get(mode);
}
