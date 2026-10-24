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

/** The environment variable that carries the agent user hash key. */
export const AGENT_USER_HASH_KEY_ENV = 'AGENT_USER_HASH_KEY';

/** The environment variable name (the value of AGENT_USER_HASH_KEY_ENV). */
export type AgentUserHashKeyEnvName = typeof AGENT_USER_HASH_KEY_ENV;

export interface AgentUserHashConfigResult {
  readonly agentUserHashKey: string | null;
  readonly problems: readonly string[];
}

export function readAgentUserHashConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): AgentUserHashConfigResult {
  const value = env[AGENT_USER_HASH_KEY_ENV];
  if (value !== undefined && value.trim() !== '') return { agentUserHashKey: value, problems: [] };
  if (appEnv !== 'prod') return { agentUserHashKey: null, problems: [] };
  return {
    agentUserHashKey: null,
    problems: [`${AGENT_USER_HASH_KEY_ENV}: must be set when APP_ENV=prod`],
  };
}
