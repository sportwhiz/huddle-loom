import { z } from 'zod';

import type { RoomCollaborationState } from './room-collaboration';

const actorSchema = z.object({ id: z.string(), name: z.string(), color: z.string() });
const commentReplySchema = z.object({
  id: z.string(), author: actorSchema, body: z.string(), mentions: z.array(z.string()),
  createdAt: z.string(), updatedAt: z.string(), deletedAt: z.string().nullable(),
});
const collaborationArchiveSchema = z.object({
  revision: z.number().int().nonnegative(),
  comments: z.array(z.object({
    id: z.string(),
    anchor: z.object({ x: z.number(), y: z.number(), objectId: z.string().nullable() }),
    createdBy: z.string(), createdAt: z.string(), resolvedAt: z.string().nullable(),
    resolvedBy: z.string().nullable(), replies: z.array(commentReplySchema),
  })),
  timer: z.object({
    status: z.enum(['running', 'paused', 'ended']), label: z.string(), startedBy: z.string(),
    startedAt: z.string(), endsAt: z.string().nullable(), remainingMs: z.number(),
  }).nullable(),
  voteRounds: z.array(z.object({
    id: z.string(), status: z.enum(['running', 'ended']), title: z.string(), targets: z.array(z.string()),
    votesPerUser: z.number().int(), maxPerTarget: z.number().int(), anonymous: z.boolean(),
    startedBy: z.string(), startedAt: z.string(), endsAt: z.string().nullable(), endedAt: z.string().nullable(),
    ballots: z.record(z.array(z.string())), ballotNames: z.record(z.string()).optional(),
  })),
  brainstorm: z.object({
    id: z.string(), status: z.enum(['running', 'closed', 'revealed', 'cancelled']), title: z.string(),
    instructions: z.string(), startedBy: z.string(), startedAt: z.string(), endsAt: z.string().nullable(),
    closedAt: z.string().nullable(), revealedAt: z.string().nullable(),
    drafts: z.record(z.object({
      id: z.string(), authorId: z.string(), text: z.string(),
      color: z.enum(['yellow', 'orange', 'green', 'blue', 'purple']),
      x: z.number(), y: z.number(), submittedAt: z.string().nullable(), updatedAt: z.string(),
    })),
    revealedIds: z.array(z.string()),
  }).nullable(),
  presentation: z.object({
    id: z.string(), status: z.enum(['running', 'ended']), presenterId: z.string(),
    frameIds: z.array(z.string()), frameIndex: z.number().int(),
    viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).nullable(), updatedAt: z.string(),
  }).nullable(),
  raisedHands: z.record(z.string()),
  checkpoints: z.array(z.object({
    id: z.string(), revision: z.number().int(), label: z.string(), createdBy: z.string(), createdAt: z.string(),
  })),
  activity: z.array(z.object({
    id: z.string(), actor: actorSchema, kind: z.string(), summary: z.string(), createdAt: z.string(),
  })),
});

export function parseCollaborationArchive(value: unknown): RoomCollaborationState | null {
  const parsed = collaborationArchiveSchema.safeParse(value);
  return parsed.success ? parsed.data as RoomCollaborationState : null;
}
