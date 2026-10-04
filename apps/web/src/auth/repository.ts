import type { SecurityState } from "./types";

export type AppIdentity = {
  id: string;
  email: string;
  name: string;
  image?: string | null;
};
export type LimitResult = { allowed: boolean; retryAfter: number };

/** Required atomic operations for an authentication storage adapter. */
export interface IdentityRepository {
  account(userId: string): Promise<SecurityState | null>;
  provision(identity: AppIdentity): Promise<void>;
  claimSetup(userId: string): Promise<boolean>;
  consumeLimit(
    key: string,
    max: number,
    seconds: number,
    now: number,
  ): Promise<LimitResult>;
}

/** Mail implementations acknowledge acceptance, not delivery. The outbox owns retries. */
export interface MailSender {
  send(message: {
    id: string;
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<{ providerId?: string }>;
}
export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };
