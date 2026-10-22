// B3-03j (编排裁定 D10-151): tool.status display text keys. The copy table is
// agent.tool_status.*; the first existing key wins, and a key name is never shown to the user.
//   platform given (validated single platform): <tool>.<phase>.<platform> → <tool>.<phase> →
//     default.<phase>
//   search_products without a platform (multi-platform search): the switched-on search platforms
//     in fixed order; two or more → search_products.<phase>.multi with {platform_names} filled
//     (falls back to the generic key while that key or a platform name is missing); exactly one →
//     as if that platform were given; none → the generic key.
//   any other tool: <tool>.<phase> → default.<phase>
// Nothing found: one warn line and an empty string.
import type { AgentRunTexts } from '../../orchestrator/index.ts';
import type { RootLogger } from '../../../platform/index.ts';

type Phase = 'start' | 'end' | 'failed';

export interface ToolStatusTextsDeps {
  /** The copy for a key, or undefined when the key does not exist. */
  readonly text: (key: string) => string | undefined;
  /** The platforms search_products actually queries for the app (its switches). */
  readonly searchPlatforms: (appId: string) => Promise<readonly string[]>;
  /** The platform's display name, or undefined when none is known. */
  readonly platformName: (platform: string) => string | undefined;
  readonly logger: Pick<RootLogger, 'warn'>;
}

const SEARCH = 'search_products';
const PLATFORM_ORDER: readonly string[] = ['taobao', 'jd', 'pdd'];
const NAMES_SEPARATOR = '、';
const NAMES_PLACEHOLDER = '{platform_names}';

function key(...parts: string[]): string {
  return `agent.tool_status.${parts.join('.')}`;
}

function rank(platform: string): number {
  const index = PLATFORM_ORDER.indexOf(platform);
  return index < 0 ? PLATFORM_ORDER.length : index;
}

/** Fixed order 淘宝、京东、拼多多; others after them in their given order; duplicates once. */
function ordered(platforms: readonly string[]): string[] {
  return [...new Set(platforms)]
    .map((platform, index) => ({ platform, index }))
    .sort((a, b) => rank(a.platform) - rank(b.platform) || a.index - b.index)
    .map((entry) => entry.platform);
}

export function createToolStatusDisplay(deps: ToolStatusTextsDeps): AgentRunTexts['toolDisplay'] {
  function first(keys: readonly string[]): string | undefined {
    for (const candidate of keys) {
      const value = deps.text(candidate);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  function chain(tool: string, phase: Phase, platform?: string): string[] {
    const keys = platform === undefined ? [] : [key(tool, phase, platform)];
    return [...keys, key(tool, phase), key('default', phase)];
  }

  async function enabled(appId: string): Promise<string[]> {
    try {
      return ordered(await deps.searchPlatforms(appId));
    } catch {
      // Unreadable switches: the generic text, never a guessed platform list.
      return [];
    }
  }

  function multi(phase: Phase, platforms: readonly string[]): string | undefined {
    const template = deps.text(key(SEARCH, phase, 'multi'));
    if (template === undefined) return undefined;
    const names: string[] = [];
    for (const platform of platforms) {
      const name = deps.platformName(platform);
      if (name === undefined) return undefined;
      names.push(name);
    }
    return template.split(NAMES_PLACEHOLDER).join(names.join(NAMES_SEPARATOR));
  }

  async function resolve(
    appId: string,
    tool: string,
    phase: Phase,
    platform?: string,
  ): Promise<string | undefined> {
    if (platform !== undefined || tool !== SEARCH) return first(chain(tool, phase, platform));
    const platforms = await enabled(appId);
    if (platforms.length >= 2) return multi(phase, platforms) ?? first(chain(tool, phase));
    return first(chain(tool, phase, platforms[0]));
  }

  return async (appId, tool, phase, platform) => {
    const value = await resolve(appId, tool, phase, platform);
    if (value !== undefined) return value;
    deps.logger.warn({ tool, phase }, 'agent_tool_status_text_missing');
    return '';
  };
}
