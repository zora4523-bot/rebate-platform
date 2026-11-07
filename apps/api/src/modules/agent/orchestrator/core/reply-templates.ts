// B3-08m · BR-AI-07 (T5 / T6): reply templates, decided by the core (orchestrator/core/run.ts) for
// every text exit of a run; no gate outside the core (stream/mount) and no reliance on the
// IntentPort's trace.calls. Rule tests: test/spec/agent/core-reply-templates/**. This file is the
// contract; it declares types only.
//
// Template tools: list_my_orders, explain_order, search_rules (get_my_earnings joins with B3-16).
//
// Template call: one model tool call of a template tool whose name is among this run's offered
//   definitions (tools.definitions of this run), whatever its outcome: ok, failed, rejected by the
//   handler, or rejected by the core for unparseable arguments. A name that was not offered (core
//   rejection without execute) is not a template call.
//
// Template keys of a run, over all its template calls (the IntentPort's templateKeys rule):
//   - orders (any list_my_orders / explain_order call): the `orders` of every ok order call's
//     outcome.trace (ReplyTemplateTrace below, as tools/orders writes it), concatenated in call
//     order; failed / rejected calls add none. 0 → order_list.empty; exactly 1 →
//     order_reason.<reason_code>.summary when reason_code is not null, else
//     order_status.<display_status>.summary; more than 1 → order_list.summary.
//   - rules (any search_rules call): agent.rule.found when some ok search_rules call's
//     outcome.trace.matched is true (tools/rules), else agent.rule.not_found (no hit, failed or
//     rejected).
//   Order of the keys when both kinds were called: orders, then rules. Each key is one
//   texts.text(appId, key) written as one ctx.text, through the run's output caps.
//
// Delivery rule (BR-AI-07「本 run 调用过订单类工具或 search_rules 时，模型生成的文本一律不下发」):
//   A run with at least one template call delivers no model text at all: not text of a tool round
//   before or after the template call (also when that text has no sentence end and sat in the
//   OutputGuard's buffer), not the final round's text, not an intent object's out_of_scope copy, not
//   the guard's tail. Instead, on every end of the run that would deliver or flush model text, the
//   template keys are written, and the run ends with the reason that end has today:
//     · final round with ordinary text, blank text (the model said nothing: templates still go
//       out), an {"agent_intent": …} object, or structured (invalid format) text → done stop;
//     · invalid format in a tool round, router degradation after delivery → done stop;
//     · the last allowed round still asking for tools, the tool call budget spent → done limit.
//   The IntentPort is not consulted for the final text of such a run. Cards and suggestions the
//   tools returned are delivered as today. Cancellation writes nothing; a reached output cap writes
//   nothing more (as today). Refused / safety endings are unchanged.
//   A run without a template call delivers its model text exactly as today: every delta through
//   the OutputGuard, in round and delta order, nothing added or dropped. Since a template call may
//   come in a later round, a run whose offered definitions include a template tool has to hold its
//   model text until it is known (e.g. until its final round or other end); when and whether to
//   hold in runs without template tools offered is the implementation's choice.
//
// Isolation: what a run has called lives in that run's own state (AgentRun), never in the factory,
//   the deps, a module-level table or anything keyed by runId that outlives the run. Runs of one
//   createAgentRunBody (same app, same deps) running one after another or interleaved never see
//   each other's calls; a later run reusing a runId starts clean.
//
// Trace: OrchestratorTrace.text_replaced_by_template is true when the run wrote template text in
//   place of the model's reply (BR-AI-07 细则「T6 与其他」); false or absent otherwise.
import type { ToolTraceFragment } from './ports.ts';

/** Template tool names the core recognises (get_my_earnings joins with B3-16). */
export type ReplyTemplateTool = 'list_my_orders' | 'explain_order' | 'search_rules';

/** One order's template input, as tools/orders puts it on its ok outcome's trace. */
export interface ReplyTemplateOrder {
  readonly reason_code: string | null;
  readonly display_status: string;
}

/**
 * The template inputs a template tool's ok outcome carries on `trace`, next to the
 * ToolTraceFragment members (never part of modelView): `orders` from list_my_orders /
 * explain_order, `matched` from search_rules.
 */
export interface ReplyTemplateTrace extends ToolTraceFragment {
  readonly orders?: readonly ReplyTemplateOrder[];
  readonly matched?: boolean;
}
