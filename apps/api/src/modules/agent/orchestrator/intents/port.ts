// B3-05f · BR-AI-01 / BR-AI-07 / BR-AI-18: the IntentPort (B3-05b). It owns the final-round output
// whenever the model answered with an intent object or the run called a template tool; ordinary
// explanation text returns null and goes back to the core. All copy comes from the text port by
// key; candidate guide routes come only from configuration ∩ contract agent_guide.
import { agent_intent as AGENT_INTENTS } from '@couli/contracts-ts';
import type { PageGuideRejectReason } from '@couli/contracts-ts';
import type { IntentPort } from '../core/ports.ts';
import type { RunBodyResult, RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import { createTextClassifier, guideTargets, intentTextPatterns } from './classify.ts';
import type { GuideTargets, TextClass, TextClassifier } from './classify.ts';
import { readRawIntent, validateIntent } from './parse.ts';
import type {
  ClarifySlot,
  IntentDeps,
  IntentOutput,
  IntentRequest,
  IntentTrace,
  TemplateCall,
} from './types.ts';

type Done = Extract<RunBodyResult, { kind: 'done' }>;
type PersonalIntent = 'order_query' | 'earnings_query';
type EarningsTopic = 'summary' | 'withdrawal_progress';

/** Intents whose label the server checks against the user's text (判定顺序②). */
type CheckedLabel = PersonalIntent | 'page_guide' | 'rule_qa';

/** Configuration and switch keys (BR-AI-01 细则「页面引导」「收益查询」, BR-AI-02 tool switches). */
interface IntentKeys {
  readonly pageGuideEnabled: string;
  readonly phoneChangeEnabled: string;
  readonly toolEnabled: (tool: string) => string;
  readonly guideText: (route: string) => string;
  readonly guideUnavailable: string;
  readonly guideAccount: (kind: 'phone' | 'phone_off' | 'delete' | 'fund') => string;
  readonly outOfScope: string;
}

function intentKeys(): IntentKeys {
  return {
    pageGuideEnabled: 'agent.page_guide.enabled',
    phoneChangeEnabled: 'account.phone_change_enabled',
    toolEnabled: (tool) => `agent.tools.${tool}.enabled`,
    guideText: (route) => `agent.guide.${route}`,
    guideUnavailable: 'agent.guide.unavailable',
    guideAccount: (kind) => `agent.guide.account.${kind}`,
    outOfScope: 'agent.refuse.out_of_scope',
  };
}

/** BR-AI-01 主体过滤: read tools behind each personal intent and the fixed auth copy. */
interface PersonalSpec {
  readonly tools: readonly string[];
  readonly needLogin: string;
  readonly needPhone: string;
}

function personalSpec(intent: PersonalIntent): PersonalSpec {
  return intent === 'order_query'
    ? {
        tools: ['list_my_orders', 'explain_order'],
        needLogin: 'agent.need_login',
        needPhone: 'agent.need_phone',
      }
    : {
        tools: ['get_my_earnings'],
        needLogin: 'agent.earnings.need_login',
        needPhone: 'agent.earnings.need_phone',
      };
}

/** BR-AI-07 T5 / T6 and BR-AI-01 「收益查询」: template key for one actual tool call. */
function templateKey(call: TemplateCall): string {
  switch (call.name) {
    case 'list_my_orders':
    case 'explain_order': {
      const [first, ...rest] = call.orders;
      if (first === undefined) return 'order_list.empty';
      if (rest.length > 0) return 'order_list.summary';
      return first.reason_code === null
        ? `order_status.${first.display_status}.summary`
        : `order_reason.${first.reason_code}.summary`;
    }
    case 'search_rules':
      return call.matched ? 'agent.rule.found' : 'agent.rule.not_found';
    case 'get_my_earnings':
      return call.status === 'shown' ? 'agent.earnings.summary' : 'agent.earnings.unavailable';
  }
}

function done(finishReason: Done['finishReason']): Done {
  return { kind: 'done', finishReason };
}

function isCheckedLabel(label: unknown): label is CheckedLabel {
  return (
    label === 'order_query' ||
    label === 'earnings_query' ||
    label === 'page_guide' ||
    label === 'rule_qa'
  );
}

/** Trace keeps a contract agent_intent value only, never arbitrary model-supplied text. */
function knownIntent(label: unknown): string | null {
  return typeof label === 'string' && (AGENT_INTENTS as readonly string[]).includes(label)
    ? label
    : null;
}

function isPersonal(label: string): label is PersonalIntent {
  return label === 'order_query' || label === 'earnings_query';
}

/** The decision after 判定顺序②: what the port does with this final round. */
type Decision =
  | {
      readonly kind: 'personal';
      readonly intent: PersonalIntent;
      readonly topic: EarningsTopic;
      /** The model's valid object when its label is the intent kept, else null. */
      readonly model: IntentOutput | null;
    }
  | {
      readonly kind: 'guide';
      /** Model-supplied route (any JSON value) or a server hint; validated before use. */
      readonly route: unknown;
      readonly extraFields: boolean;
    }
  | { readonly kind: 'continue'; readonly intent: IntentOutput }
  | { readonly kind: 'clarify'; readonly slot: ClarifySlot }
  | { readonly kind: 'refuse'; readonly intent: string | null };

class IntentHandler {
  private readonly keys = intentKeys();
  private readonly targets: GuideTargets = guideTargets();
  private readonly classifier: TextClassifier;
  private readonly deps: IntentDeps;

  constructor(deps: IntentDeps) {
    this.deps = deps;
    this.classifier = createTextClassifier(intentTextPatterns(), this.targets);
  }

  async handle(request: IntentRequest, ctx: RunContext): Promise<RunBodyResult | null> {
    const appId = request.input.caller.appId;
    const runId = request.input.runId;
    const raw = readRawIntent(request.text);
    const label = raw.kind === 'object' ? knownIntent(raw.value['agent_intent']) : null;

    // BR-AI-07: an actual order / rule / earnings call in this run replaces any final model text.
    const calls = await this.deps.trace.calls(appId, runId);
    const last = calls.at(-1);
    if (last !== undefined) {
      await this.fixedText(request, ctx, templateKey(last));
      this.record(request, { intent: label, replaced: true });
      return done('stop');
    }
    if (raw.kind === 'none') return null;

    const decision = await this.decide(request, raw);
    switch (decision.kind) {
      case 'personal':
        return this.personal(request, ctx, decision);
      case 'guide':
        return this.guide(request, ctx, 'page_guide', decision.route, decision.extraFields);
      case 'continue':
        this.record(request, { intent: decision.intent.agent_intent, replaced: false });
        return this.deps.continuation.run(decision.intent, request, ctx);
      case 'clarify':
        return this.clarify(request, ctx, decision.slot);
      case 'refuse':
        // BR-AI-18: out_of_scope, and any malformed or unknown intent, drop the model text.
        await this.fixedText(request, ctx, this.keys.outOfScope);
        this.record(request, { intent: decision.intent, replaced: true });
        return done('stop');
    }
  }

  /** 判定顺序②: the model's label checked against the user's own text, raised only. */
  private async decide(
    request: IntentRequest,
    raw: Exclude<ReturnType<typeof readRawIntent>, { kind: 'none' }>,
  ): Promise<Decision> {
    if (raw.kind === 'broken') return { kind: 'refuse', intent: null };
    const label = raw.value['agent_intent'];
    const valid = validateIntent(raw.value);
    if (isCheckedLabel(label)) {
      const checked = this.classifier.classify(request.input.text);
      const personal = await this.personalFromText(request, checked, label);
      if (personal !== null) {
        const modelTopic = valid?.agent_intent === 'earnings_query' ? valid.topic : undefined;
        const withdrawal = 'withdrawal' in checked && checked.withdrawal;
        const topic = withdrawal ? 'withdrawal_progress' : (modelTopic ?? 'summary');
        // The model's own object is forwarded unchanged only when its label is the one kept.
        const model = valid !== null && valid.agent_intent === personal ? valid : null;
        return { kind: 'personal', intent: personal, topic, model };
      }
      if (label === 'rule_qa' && checked.kind === 'page' && checked.route !== null) {
        return { kind: 'guide', route: checked.route, extraFields: false };
      }
      if (label === 'page_guide') {
        const extraFields = Object.keys(raw.value).some(
          (key) => key !== 'agent_intent' && key !== 'guide_route',
        );
        return { kind: 'guide', route: raw.value['guide_route'], extraFields };
      }
    }
    if (valid === null) return { kind: 'refuse', intent: knownIntent(label) };
    switch (valid.agent_intent) {
      case 'out_of_scope':
        return { kind: 'refuse', intent: 'out_of_scope' };
      case 'clarify':
        return { kind: 'clarify', slot: valid.slot };
      default:
        return { kind: 'continue', intent: valid };
    }
  }

  /** Personal intent after the text check, or null when the message is not about own data. */
  private async personalFromText(
    request: IntentRequest,
    checked: TextClass,
    label: CheckedLabel,
  ): Promise<PersonalIntent | null> {
    switch (checked.kind) {
      case 'order':
        return 'order_query';
      case 'earnings':
        return 'earnings_query';
      case 'personal': {
        // Elliptical follow-ups (那返了吗) continue a preceding order; otherwise own earnings,
        // unless the model already chose one of the two personal intents.
        const previous = await this.deps.continuation.previousIntent(request);
        if (previous === 'order_query') return 'order_query';
        return isPersonal(label) ? label : 'earnings_query';
      }
      default:
        return isPersonal(label) ? label : null;
    }
  }

  /** 判定顺序③④: identity before availability; degrade to a guide only for phone-bound users. */
  private async personal(
    request: IntentRequest,
    ctx: RunContext,
    { intent, topic, model }: Extract<Decision, { kind: 'personal' }>,
  ): Promise<RunBodyResult> {
    const caller = request.input.caller;
    const spec = personalSpec(intent);
    if (caller.userId === null || !caller.phoneBound) {
      const login = caller.userId === null;
      const key = login ? spec.needLogin : spec.needPhone;
      const text = await this.text(request, key);
      ctx.text(text);
      await ctx.card({
        type: 'auth_required',
        schema_version: 1,
        data: { platform: null, reason: login ? 'login' : 'bind_phone', resume_link_id: null },
        fallback_text: text,
      });
      this.record(request, { intent, replaced: true });
      return done('auth_required');
    }
    if (await this.anyToolAvailable(request, spec.tools)) {
      this.record(request, { intent, replaced: false });
      return this.deps.continuation.run(model ?? personalIntent(intent, topic), request, ctx);
    }
    const route =
      intent === 'order_query'
        ? this.targets.orderList
        : topic === 'withdrawal_progress'
          ? this.targets.withdrawRecords
          : this.targets.wallet;
    return this.guide(request, ctx, intent, route, false);
  }

  private async anyToolAvailable(
    request: IntentRequest,
    tools: readonly string[],
  ): Promise<boolean> {
    const appId = request.input.caller.appId;
    for (const tool of tools) {
      if (!this.deps.tools.registered(tool)) continue;
      if (await this.deps.flags.enabled(appId, this.keys.toolEnabled(tool))) return true;
    }
    return false;
  }

  /** BR-AI-01 「页面引导」: source → fields → switch → configuration ∩ contract. */
  private async guide(
    request: IntentRequest,
    ctx: RunContext,
    intent: string,
    route: unknown,
    extraFields: boolean,
  ): Promise<RunBodyResult> {
    const reason = await this.guideRejection(request, route, extraFields);
    if (reason === null && typeof route === 'string') {
      const textKey = this.keys.guideText(route);
      await ctx.card({
        type: 'page_guide',
        schema_version: 1,
        data: { route, text_key: textKey },
        fallback_text: await this.text(request, textKey),
      });
    } else {
      await this.fixedText(request, ctx, await this.rejectionKey(request, reason, route));
    }
    this.record(request, { intent, replaced: true, reason });
    return done('stop');
  }

  private async guideRejection(
    request: IntentRequest,
    route: unknown,
    extraFields: boolean,
  ): Promise<PageGuideRejectReason | null> {
    const appId = request.input.caller.appId;
    if (request.proceed.untrustedInput) return 'untrusted_input';
    if (request.proceed.paramsRequested) return 'params_requested';
    if (extraFields) return 'extra_fields';
    if (!(await this.deps.flags.enabled(appId, this.keys.pageGuideEnabled))) return 'disabled';
    if (typeof route !== 'string') return 'not_allowed';
    const contract = this.deps.routes.contract();
    const inContract = Object.hasOwn(contract, route) && contract[route]?.agent_guide === true;
    if (!inContract) return 'not_allowed';
    const configured = await this.deps.routes.configured(appId);
    return configured.includes(route) ? null : 'not_allowed';
  }

  /** Account-safety routes get their own copy; every other rejection is the neutral one. */
  private async rejectionKey(
    request: IntentRequest,
    reason: PageGuideRejectReason | null,
    route: unknown,
  ): Promise<string> {
    if (reason !== 'not_allowed' || typeof route !== 'string') return this.keys.guideUnavailable;
    const contract = this.deps.routes.contract();
    const account = Object.hasOwn(contract, route) ? contract[route]?.agent_guide_account : null;
    switch (account) {
      case 'phone': {
        const appId = request.input.caller.appId;
        const on = await this.deps.flags.enabled(appId, this.keys.phoneChangeEnabled);
        return this.keys.guideAccount(on ? 'phone' : 'phone_off');
      }
      case 'delete':
      case 'fund':
        return this.keys.guideAccount(account);
      default:
        return this.keys.guideUnavailable;
    }
  }

  /** BR-AI-01 追问: one question per chain and slot; afterwards resolve without asking. */
  private async clarify(
    request: IntentRequest,
    ctx: RunContext,
    slot: ClarifySlot,
  ): Promise<RunBodyResult> {
    const appId = request.input.caller.appId;
    const clarification = this.deps.clarification;
    const scope = await clarification.scope(request);
    this.record(request, { intent: 'clarify', replaced: true });
    if (await clarification.takeOnce(scope, slot)) {
      ctx.suggestions([...(await clarification.options(slot))]);
      return done('stop');
    }
    if (slot === 'reference') {
      const [first] = await clarification.latestProducts(scope);
      if (first === undefined) {
        // No result set to point at: nothing can be chosen and the question was already asked.
        await this.fixedText(request, ctx, this.keys.outOfScope);
        return done('stop');
      }
      await this.cards(ctx, [first, await clarification.fallbackNotice(appId, slot)]);
      return done('stop');
    }
    await ctx.card(await clarification.fallbackNotice(appId, slot));
    return clarification.withoutCondition(slot, request, ctx);
  }

  private async cards(ctx: RunContext, cards: readonly UnnumberedCard[]): Promise<void> {
    for (const card of cards) await ctx.card(card);
  }

  private text(request: IntentRequest, key: string): Promise<string> {
    return this.deps.texts.text(request.input.caller.appId, key);
  }

  private async fixedText(request: IntentRequest, ctx: RunContext, key: string): Promise<void> {
    ctx.text(await this.text(request, key));
  }

  private record(
    request: IntentRequest,
    value: {
      readonly intent: string | null;
      readonly replaced: boolean;
      readonly reason?: PageGuideRejectReason | null;
    },
  ): void {
    const trace: IntentTrace = {
      intent: value.intent,
      text_replaced_by_template: value.replaced,
      page_guide_reject_reason: value.reason ?? null,
    };
    this.deps.trace.record(request.input.caller.appId, request.input.runId, trace);
  }
}

/** A server-built personal intent (the model's label was raised by 判定顺序②). */
function personalIntent(intent: PersonalIntent, topic: EarningsTopic): IntentOutput {
  return intent === 'order_query'
    ? { agent_intent: intent }
    : { agent_intent: intent, ...(topic === 'summary' ? {} : { topic }) };
}

/** Implements B3-05b IntentPort: ordinary text returns null; all consumed intents return done.
 * BR-AI-01 classification checks user text + preceding context: personal order > personal
 * earnings > page location > generic rules. Input flags prohibit guides, not auth_required.
 * Identity precedes availability. Orders degrade only when both read tools are unavailable.
 * Guide checks use current configuration intersected with contract metadata; no hardcoded
 * candidate list. Source rejection takes priority over fields, switches and route membership.
 * Successful guides emit only one card; rejected guides only fixed text; neither emits chips.
 * BR-AI-07 actual calls replace even ordinary final text, before ordinary-text pass-through.
 * BR-AI-01 clarify: once per chain/slot across runs, then first latest product or drop condition
 * plus the injected notice. BR-AI-18 out_of_scope always discards model text.
 */
export function createIntentPort(deps: IntentDeps): IntentPort {
  const handler = new IntentHandler(deps);
  return { handle: (request, ctx) => handler.handle(request, ctx) };
}
