import type { Capabilities, Principal, Role } from './collaboration-types';

export type RoomParticipant = Pick<Principal, 'id' | 'name' | 'avatarUrl' | 'color'> & {
  guest?: boolean;
  connectionId: string;
  role: Role;
  cursor?: { x: number; y: number };
  selection?: string[];
  viewport?: { x: number; y: number; zoom: number };
  idle: boolean;
  raisedAt?: string;
};

export type CommentReply = {
  id: string;
  author: Pick<Principal, 'id' | 'name' | 'color'>;
  body: string;
  mentions: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type CommentThread = {
  id: string;
  anchor: { x: number; y: number; objectId: string | null };
  createdBy: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  replies: CommentReply[];
};

export type WorkshopTimer = {
  status: 'running' | 'paused' | 'ended';
  label: string;
  startedBy: string;
  startedAt: string;
  endsAt: string | null;
  remainingMs: number;
};

export type VoteRound = {
  id: string;
  status: 'running' | 'ended';
  title: string;
  targets: string[];
  votesPerUser: number;
  maxPerTarget: number;
  anonymous: boolean;
  startedBy: string;
  startedAt: string;
  endsAt: string | null;
  endedAt: string | null;
  ballots: Record<string, string[]>;
  ballotNames?: Record<string, string>;
};

export type BrainstormDraft = {
  id: string;
  authorId: string;
  text: string;
  color: 'yellow' | 'orange' | 'green' | 'blue' | 'purple';
  x: number;
  y: number;
  submittedAt: string | null;
  updatedAt: string;
};

export type BrainstormSession = {
  id: string;
  status: 'running' | 'closed' | 'revealed' | 'cancelled';
  title: string;
  instructions: string;
  startedBy: string;
  startedAt: string;
  endsAt: string | null;
  closedAt: string | null;
  revealedAt: string | null;
  drafts: Record<string, BrainstormDraft>;
  revealedIds: string[];
};

export type PresentationSession = {
  id: string;
  status: 'running' | 'ended';
  presenterId: string;
  frameIds: string[];
  frameIndex: number;
  viewport: { x: number; y: number; zoom: number } | null;
  updatedAt: string;
};

export type ActivityEntry = {
  id: string;
  actor: Pick<Principal, 'id' | 'name' | 'color'>;
  kind: string;
  summary: string;
  createdAt: string;
};

export type NamedCheckpoint = {
  id: string;
  revision: number;
  label: string;
  createdBy: string;
  createdAt: string;
};

export type RoomCollaborationState = {
  revision: number;
  comments: CommentThread[];
  timer: WorkshopTimer | null;
  voteRounds: VoteRound[];
  brainstorm: BrainstormSession | null;
  presentation: PresentationSession | null;
  raisedHands: Record<string, string>;
  checkpoints: NamedCheckpoint[];
  activity: ActivityEntry[];
};

export type PublicCollaborationState = Omit<RoomCollaborationState, 'voteRounds' | 'brainstorm'> & {
  voteRounds: Array<Omit<VoteRound, 'ballots' | 'ballotNames'> & {
    myVotes: string[];
    results: Record<string, number> | null;
    voterNames: Record<string, string[]> | null;
  }>;
  brainstorm: (Omit<BrainstormSession, 'drafts'> & {
    myDrafts: BrainstormDraft[];
    submittedCount: number;
    participantCount: number;
  }) | null;
  participants: RoomParticipant[];
  capabilities: Capabilities;
  currentUserId: string;
};

export type RoomSession = {
  boardId: string;
  principal: Principal;
  capabilities: Capabilities;
  connectionId: string;
  presence: Omit<RoomParticipant, keyof Principal | 'connectionId' | 'role'>;
  authorizationCheckedAt?: number;
};

export function emptyCollaborationState(): RoomCollaborationState {
  return {
    revision: 0,
    comments: [],
    timer: null,
    voteRounds: [],
    brainstorm: null,
    presentation: null,
    raisedHands: {},
    checkpoints: [],
    activity: [],
  };
}
