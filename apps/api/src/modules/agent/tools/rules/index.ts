// B3-08b · BR-AI-07 T6 / BR-AI-05 / BR-AI-03: search_rules. Scores the app's active rule chunks
// against the question by character-bigram Dice (no external embedding, D10-194); the top 3 at or
// above agent.rag.min_score become rule_ref cards, no hit gives the shared handoff card. The model
// sees only card references and wrapped titles, never the published text.
import { wrapUntrusted } from '../../guard/index.ts';
import type { ToolOutcome, ToolTraceFragment } from '../../orchestrator/index.ts';
import type { UnnumberedCard } from '../../stream/run/index.ts';
import { handoffCard } from '../handoff/index.ts';
import type { ToolCallContext, ToolDefinition, ToolHandler } from '../registry/index.ts';

export interface RuleChunkRow {
  chunk_id: string;
  article_id: string;
  published_version: number;
  title: string;
  text: string;
}

export interface RulesDeps {
  activeChunks(appId: string): Promise<readonly RuleChunkRow[]>;
  config(appId: string, key: 'agent.rag.min_score'): Promise<unknown>;
  texts?(appId: string, key: string): Promise<string>;
  cardReference?(ctx: ToolCallContext, index: number): string;
}

function toolName(): 'search_rules' {
  return 'search_rules';
}

function maxQuestionLength(): number {
  return 200;
}

function maxCards(): number {
  return 3;
}

/** 08 gives no default for agent.rag.min_score; reported to the orchestrator (brief §9). */
function defaultMinScore(): number {
  return 0.2;
}

/** card_rule_ref.excerpt maxLength, counted in code points as JSON Schema does. */
function maxExcerptLength(): number {
  return 200;
}

/** NFKC, lower case, then drop whitespace, punctuation and control/format characters. */
function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{Z}\p{C}]/gu, '');
}

/** Set of adjacent bigrams over Unicode code points (never split a surrogate pair). */
function bigrams(text: string): Set<string> {
  const chars = Array.from(normalize(text));
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i += 1) out.add(chars[i]! + chars[i + 1]!);
  return out;
}

/** Dice coefficient 2|A∩B|/(|A|+|B|) over bigram sets; 0 when either side has no bigram. */
export function scoreRule(question: string, chunk: { title: string; text: string }): number {
  const a = bigrams(question);
  const b = bigrams(chunk.title + chunk.text);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

function definition(): ToolDefinition {
  return {
    name: toolName(),
    description:
      '用户询问平台规则（提现、返利、找回、账号等规则说明）时调用，按问句检索已发布的规则条目并以卡片展示原文。只传用户的问题，不要传账号或订单信息。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: { type: 'string', minLength: 1, maxLength: maxQuestionLength() },
      },
    },
  };
}

/** Valid only as a finite number in [0, 1]; anything else (or a failing read) falls back. */
async function minScore(deps: RulesDeps, appId: string): Promise<number> {
  try {
    const value = await deps.config(appId, 'agent.rag.min_score');
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
      ? value
      : defaultMinScore();
  } catch {
    return defaultMinScore();
  }
}

/** A chunk that cannot make a contract-valid card is never shown (no half card). */
function cardable(row: RuleChunkRow): boolean {
  return (
    typeof row.chunk_id === 'string' &&
    typeof row.article_id === 'string' &&
    Number.isSafeInteger(row.published_version) &&
    typeof row.title === 'string' &&
    row.title !== '' &&
    typeof row.text === 'string' &&
    row.text !== '' &&
    Array.from(row.text).length <= maxExcerptLength()
  );
}

/** Score descending, ties by chunk_id ascending; at most three at or above the threshold. */
function selectHits(question: string, rows: readonly RuleChunkRow[], threshold: number) {
  return rows
    .filter(cardable)
    .map((row) => ({ row, score: scoreRule(question, row) }))
    .filter((hit) => hit.score >= threshold)
    .sort((x, y) => {
      if (x.score !== y.score) return y.score - x.score;
      if (x.row.chunk_id === y.row.chunk_id) return 0;
      return x.row.chunk_id < y.row.chunk_id ? -1 : 1;
    })
    .slice(0, maxCards())
    .map((hit) => hit.row);
}

/** contracts/agent-stream.schema.json $defs.card_rule_ref, unnumbered; excerpt is the text as is. */
function ruleRefCard(row: RuleChunkRow): UnnumberedCard {
  return {
    type: 'rule_ref',
    schema_version: 1,
    data: {
      chunk_id: row.chunk_id,
      title: row.title,
      excerpt: row.text,
      published_version: String(row.published_version),
      action: { route: 'Help', params: { article_id: row.article_id } },
    },
    fallback_text: row.title,
  };
}

/** The intents port reads matched per search_rules call; ToolTraceFragment has no field yet. */
function rulesTrace(matched: boolean): ToolTraceFragment & { readonly matched: boolean } {
  return { matched };
}

export function createSearchRulesHandler(deps: RulesDeps): ToolHandler {
  async function run(
    args: Readonly<Record<string, unknown>>,
    ctx: ToolCallContext,
  ): Promise<ToolOutcome> {
    const question = typeof args['question'] === 'string' ? args['question'] : '';
    let rows: readonly RuleChunkRow[];
    let threshold: number;
    try {
      // BR-AI-03: the app comes only from the server context, never from arguments.
      [rows, threshold] = await Promise.all([
        deps.activeChunks(ctx.appId),
        minScore(deps, ctx.appId),
      ]);
    } catch {
      return { kind: 'failed', modelView: { error: 'tool_failed' } };
    }
    const hits = selectHits(question, rows, threshold);
    const reference = deps.cardReference;

    if (hits.length === 0) {
      const cards = [await handoffCard(deps, ctx.appId)];
      const modelView = reference === undefined ? {} : { card_id: reference(ctx, 0) };
      return { kind: 'ok', modelView, cards, trace: rulesTrace(false) };
    }

    const cards = hits.map(ruleRefCard);
    // BR-AI-05: only the card reference (by position in cards) and the wrapped title.
    const modelView = {
      cards: hits.map((row, index) => ({
        ...(reference === undefined ? {} : { card_id: reference(ctx, index) }),
        title: wrapUntrusted(row.title),
      })),
    };
    return { kind: 'ok', modelView, cards, trace: rulesTrace(true) };
  }

  return { name: toolName(), definition: definition(), audience: 'all', run };
}
