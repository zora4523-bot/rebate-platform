// B3-09e (BR-AI-22, D10-175): Agent data purge on account deletion. Skeleton only; the deletion
// cleanup transaction (B1-15g) calls purgeAgentDataForUser on its own transaction.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export interface PurgeAgentDataInput {
  appId: string;
  userId: string;
  at: Date;
}

export interface PurgeAgentDataResult {
  sessions: number;
  messages: number;
}

export interface AgentDataPurge {
  purgeAgentDataForUser(
    trx: Transaction<DB>,
    input: PurgeAgentDataInput,
  ): Promise<PurgeAgentDataResult>;
}

export function createAgentDataPurge(deps: { userHashKey: string }): AgentDataPurge {
  void deps;
  throw new Error('NotImplemented: createAgentDataPurge');
}

export function agentUserHash(key: string, userId: string): string {
  void key;
  void userId;
  throw new Error('NotImplemented: agentUserHash');
}

export function readAgentUserHashKey(env: Readonly<Record<string, string | undefined>>): string {
  void env;
  throw new Error('NotImplemented: readAgentUserHashKey');
}

export function purgedCardText(): string {
  throw new Error('NotImplemented: purgedCardText');
}
