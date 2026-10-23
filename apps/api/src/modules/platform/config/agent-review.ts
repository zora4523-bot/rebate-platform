// Agent content safety review settings (B3-03m; BR-AI-18; owner D10-135 ②): the Aliyun AccessKey
// pair and the review endpoint of the stream entry. Pure: only looks at the given object, never
// echoes a value in a problem.
//
// - local / test: nothing is read (their review stays a fail-closed stand-in, AGENTS.md §6);
//   setting either credential name is refused by startupViolations (./credential-env.ts lists
//   both names).
// - staging / prod: both credential halves and an https endpoint → the config; only one half set,
//   or an endpoint that is not an https URL → problem; credentials or endpoint absent → null, and
//   the review fails closed (every message refused as review unavailable, no network request).
//   TODO(规划/11 §6): 真实调用验证 — blocked on 负责人在 staging 放入阿里云内容安全 Key
import type { AppEnv } from './app-env.ts';
import { readAgentReviewCredentials } from './credential-env.ts';

export const AGENT_REVIEW_ENDPOINT_ENV = 'AGENT_REVIEW_ALIYUN_ENDPOINT';

export interface AgentReviewConfig {
  readonly credentials: { readonly accessKeyId: string; readonly accessKeySecret: string };
  /** https URL of the Aliyun text moderation endpoint (a server setting, not a credential). */
  readonly endpoint: string;
}

const set = (env: Readonly<Record<string, string | undefined>>, name: string): boolean =>
  (env[name] ?? '').trim() !== '';

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function readAgentReviewConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): { readonly agentReview: AgentReviewConfig | null; readonly problems: readonly string[] } {
  if (appEnv !== 'staging' && appEnv !== 'prod') return { agentReview: null, problems: [] };
  const problems: string[] = [];
  const hasId = set(env, 'AGENT_REVIEW_ALIYUN_ACCESS_KEY_ID');
  const hasSecret = set(env, 'AGENT_REVIEW_ALIYUN_ACCESS_KEY_SECRET');
  if (hasId !== hasSecret) {
    problems.push(
      `AGENT_REVIEW_ALIYUN_ACCESS_KEY_ID, AGENT_REVIEW_ALIYUN_ACCESS_KEY_SECRET: must be set together when APP_ENV=${appEnv}`,
    );
  }
  const endpoint = env[AGENT_REVIEW_ENDPOINT_ENV] ?? '';
  if (endpoint !== '' && !isHttpsUrl(endpoint)) {
    problems.push(`${AGENT_REVIEW_ENDPOINT_ENV}: must be an https URL`);
  }
  if (problems.length > 0) return { agentReview: null, problems };
  const credentials = readAgentReviewCredentials(appEnv, env);
  if (credentials === undefined || endpoint === '') return { agentReview: null, problems: [] };
  return { agentReview: Object.freeze({ credentials, endpoint }), problems: [] };
}
