// The agent module's only public entry (apps/api/AGENTS.md): other modules import from here.
// B3-03d adds the HTTP layer and the session store; B3-03h the worker assembly of the left-over
// run sweeper (AgentModule.forWorker, agentSweeperToken); the HTTP mount is B3-03f.
// B3-09i: the deletion cleanup port of B3-09e (BR-AI-22), for app.module's deletionCleanupPorts.
import type { AgentDataPurge } from './deletion/index.ts';

export * from './http/index.ts';
export * from './store/index.ts';
export * from './agent.module.ts';
export * from './stream/mount/index.ts';
export type {
  AgentDataPurge,
  PurgeAgentDataInput,
  PurgeAgentDataResult,
} from './deletion/index.ts';

export function createAgentDataPurge(deps: { userHashKey: string }): AgentDataPurge {
  void deps;
  throw new Error('NotImplemented: createAgentDataPurge');
}

export function readAgentUserHashKey(env: Readonly<Record<string, string | undefined>>): string {
  void env;
  throw new Error('NotImplemented: readAgentUserHashKey');
}

export function agentUserHash(key: string, userId: string): string {
  void key;
  void userId;
  throw new Error('NotImplemented: agentUserHash');
}

export function purgedCardText(): string {
  throw new Error('NotImplemented: purgedCardText');
}
