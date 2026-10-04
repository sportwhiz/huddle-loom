import { apiFetch } from "./auth-client";
import type { NativeBoardSnapshot } from './blocksuite/runtime/snapshot';
import type { PublicCollaborationState } from './room-collaboration';

export type BoardBootstrap = {
  revision: number;
  updatedAt: string;
  documentEpoch: string;
  snapshot: NativeBoardSnapshot;
  collaboration: PublicCollaborationState;
  metadata: { title: string; workbookTitle: string; canCopy: boolean };
};

export async function loadBoardBootstrap(boardId: string, signal: AbortSignal): Promise<BoardBootstrap> {
  const response = await apiFetch(`/api/v1/boards/${encodeURIComponent(boardId)}/bootstrap`, { signal });
  if (!response.ok) throw new Error(`Board request failed with ${response.status}`);
  return response.json();
}
