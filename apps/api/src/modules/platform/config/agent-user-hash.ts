// AGENT_USER_HASH_KEY (B3-09j; BR-AI-22, D10-175): the HMAC key of the agent user hash written by
// agent's deletion purge (agent_sessions.user_hash, quota_subjects). Kept apart from the phone
// HMAC key (F-ACC-10). Pure: only looks at the given object, never echoes a value in a problem.
//
// - any APP_ENV, value not blank → the value as set, no problem.
// - prod, missing / empty / blank → null and one problem starting with `AGENT_USER_HASH_KEY`
//   (loadConfig refuses to start).
// - local / test / staging, missing / empty / blank → null, no problem (app.module keeps the agent
//   cleanup port unavailable and warns).
import type { AppEnv } from './app-env.ts';

/** The environment variable name (the implementation exports it as AGENT_USER_HASH_KEY_ENV). */
export type AgentUserHashKeyEnvName = 'AGENT_USER_HASH_KEY';

export interface AgentUserHashConfigResult {
  readonly agentUserHashKey: string | null;
  readonly problems: readonly string[];
}

export function readAgentUserHashConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): AgentUserHashConfigResult {
  void appEnv;
  void env;
  throw new Error('NotImplemented: readAgentUserHashConfig');
}
