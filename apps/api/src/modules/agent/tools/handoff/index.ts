// B3-08c · BR-AI-01 / BR-AI-03 / BR-AI-05: handoff_to_human. No arguments; one handoff card whose
// entry is the originating page's route name and whose summary is dictionary text. The model's
// reason, identity and order identifiers never reach the card. handoffCard is shared with the
// order tools (no orders) and search_rules (no hit).
import type { ToolOutcome } from '../../orchestrator/index.ts';
import type { UnnumberedCard } from '../../stream/run/index.ts';
import type { ToolCallContext, ToolDefinition, ToolHandler } from '../registry/index.ts';

export interface HandoffDeps {
  /** Dictionary text (BR-TEXT-22); the key itself is used when absent, empty or failing. */
  texts?(appId: string, key: string): Promise<string>;
  /** B3-05i core cardReference; without it the model view carries no card_id. */
  cardReference?(ctx: ToolCallContext, index: number): string;
}

function toolName(): 'handoff_to_human' {
  return 'handoff_to_human';
}

/** routes.json route name of the Agent page, the page the handoff starts from. */
function entryRoute(): string {
  return 'AgentChat';
}

function summaryKey(): string {
  return 'agent.card.handoff.desc';
}

function titleKey(): string {
  return 'agent.card.handoff.title';
}

/** Same fallback rule as search's fallbackText: key when not wired, empty or failing. */
async function dictionaryText(deps: HandoffDeps, appId: string, key: string): Promise<string> {
  if (deps.texts === undefined) return key;
  try {
    const text = await deps.texts(appId, key);
    return typeof text === 'string' && text !== '' ? text : key;
  } catch {
    return key;
  }
}

/** Closed, empty parameter schema (BR-AI-03): any argument is rejected by the registry. */
function definition(): ToolDefinition {
  return {
    name: toolName(),
    description:
      '用户需要人工客服时调用，给出联系客服的卡片。不需要任何参数，不要传理由或账号、订单信息。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  };
}

/** The one handoff card (04 §8.3 card_handoff): only entry and summary, unnumbered. */
export async function handoffCard(deps: HandoffDeps, appId: string): Promise<UnnumberedCard> {
  const [summary, title] = await Promise.all([
    dictionaryText(deps, appId, summaryKey()),
    dictionaryText(deps, appId, titleKey()),
  ]);
  return {
    type: 'handoff',
    schema_version: 1,
    data: { entry: entryRoute(), summary },
    fallback_text: title,
  };
}

export function createHandoffHandler(deps: HandoffDeps): ToolHandler {
  async function run(
    args: Readonly<Record<string, unknown>>,
    ctx: ToolCallContext,
  ): Promise<ToolOutcome> {
    // The registry has already enforced the empty schema; arguments are never read.
    void args;
    const card = await handoffCard(deps, ctx.appId);
    const cards = [card];
    const reference = deps.cardReference;
    // BR-AI-05: the model sees at most the card reference, never the card text.
    const modelView =
      reference === undefined ? {} : { card_id: reference(ctx, cards.indexOf(card)) };
    return { kind: 'ok', modelView, cards };
  }

  return { name: toolName(), definition: definition(), audience: 'all', run };
}
