// B1-12z · One template code as GET /admin/v1/notify-channels returns it (CT-24t
// AdminNotifyChannelItem; 08 BR-TEXT-20 细则「短信渠道登记与后台渠道开关」, BR-TEXT-09 细则 channel
// column; orchestrator rulings D10-337 ②, D10-339 ⑥, D10-341), computed from the code's
// notify_templates rows (one per variant) and the catalog:
//   - push_switchable: not inbox-only and the default channels hold inbox;
//   - sms_switchable: not inbox-only, service category, not SMS-fixed;
//   - sms_registrations: one row per variant when the code may send SMS (fixed or switchable);
//   - sms_ready: every variant has an in-use registration (false without SMS rows);
//   - sms_deploy_fallback: SMS_CODE while not ready (the deployment configuration stands in);
//   - sms_state: disabled (no sms in channels), enabled (ready or on the fallback), else
//     enabled_not_ready;
//   - row_version: the code's version (every write raises it on all of its rows).
// The schema has no enabled_at column: enabled_at is the row's updated_at, which only the writes of
// the in-use registration (enable, in-place edit) touch. saved_at is sms_pending_saved_at, written
// by the save and left alone by a retest (B1-12zb, D10-355 ①); a pending row saved before that
// column existed has it NULL and falls back to sms_tested_at.
//
// Pure module (no decorators, erasable syntax).
import {
  CHANNEL_ORDER,
  DEFAULT_VARIANT,
  VERIFY_CODE,
  definitionOf,
  variablesOf,
  type NotifyChannel,
  type SmsTemplateType,
} from './catalog.ts';

/** The notify_templates columns the console reads. */
export interface TemplateRow {
  readonly code: string;
  readonly variant: string;
  readonly category: string;
  readonly channels: readonly string[];
  readonly row_version: number;
  readonly updated_at: Date;
  readonly sms_sign_name: string | null;
  readonly sms_template_code: string | null;
  readonly sms_template_type: string | null;
  readonly sms_preview_text: string | null;
  readonly sms_pending_sign_name: string | null;
  readonly sms_pending_template_code: string | null;
  readonly sms_pending_template_type: string | null;
  readonly sms_pending_preview_text: string | null;
  readonly sms_test_status: string | null;
  readonly sms_tested_at: Date | null;
  /** When the pending registration was saved; null on a pending row saved before B1-12zb. */
  readonly sms_pending_saved_at: Date | null;
}

export type NotifyCategory = 'service' | 'subscription' | 'marketing';
export type SmsState = 'disabled' | 'enabled' | 'enabled_not_ready';
export type SmsTestStatus = 'accepted' | 'failed' | 'not_sent_no_verify_phone';

export interface ActiveView {
  readonly sign_name: string;
  readonly template_code: string;
  readonly template_type: SmsTemplateType;
  readonly preview_text: string;
  readonly enabled_at: string;
}

export interface PendingView {
  readonly sign_name: string;
  readonly template_code: string;
  readonly template_type: SmsTemplateType;
  readonly preview_text: string;
  readonly saved_at: string;
  readonly test: { readonly status: SmsTestStatus; readonly tested_at: string };
}

export interface VariantView {
  readonly variant: string;
  readonly variables: string[];
  readonly active: ActiveView | null;
  readonly pending: PendingView | null;
}

export interface ItemView {
  readonly code: string;
  readonly category: NotifyCategory;
  readonly default_channels: NotifyChannel[];
  readonly channels: NotifyChannel[];
  readonly push_switchable: boolean;
  readonly sms_switchable: boolean;
  readonly sms_fixed: boolean;
  readonly sms_billing_confirm: boolean;
  readonly fund_terms: boolean;
  readonly sms_ready: boolean;
  readonly sms_state: SmsState;
  readonly sms_deploy_fallback: boolean;
  readonly sms_code_ttl_sec: number | null;
  readonly sms_registrations: VariantView[];
  readonly row_version: number;
}

/** What may be changed on a code, from its rows and the catalog. */
export interface CodeTraits {
  readonly category: NotifyCategory;
  readonly channels: NotifyChannel[];
  readonly defaultChannels: NotifyChannel[];
  readonly pushSwitchable: boolean;
  readonly smsSwitchable: boolean;
  readonly smsFixed: boolean;
  readonly smsBillingConfirm: boolean;
  readonly smsReady: boolean;
  readonly rowVersion: number;
}

const TYPES: ReadonlySet<string> = new Set(['verify', 'notice']);
const STATUSES: ReadonlySet<string> = new Set(['accepted', 'failed', 'not_sent_no_verify_phone']);
const CATEGORIES: ReadonlySet<string> = new Set(['service', 'subscription', 'marketing']);

function isCategory(value: string): value is NotifyCategory {
  return CATEGORIES.has(value);
}

/** Channels in display order, each once, only known ones. */
export function orderedChannels(channels: readonly string[]): NotifyChannel[] {
  return CHANNEL_ORDER.filter((channel) => channels.includes(channel));
}

/** The default variant's row, else the first one (rows are never empty here). */
export function primaryRow(rows: readonly TemplateRow[]): TemplateRow {
  const primary = rows.find((row) => row.variant === DEFAULT_VARIANT) ?? rows[0];
  if (primary === undefined) throw new Error('notification: a template code without rows');
  return primary;
}

/** Variants in answer order: default first, then by name. */
export function sortedRows(rows: readonly TemplateRow[]): TemplateRow[] {
  return [...rows].sort((a, b) => {
    if (a.variant === b.variant) return 0;
    if (a.variant === DEFAULT_VARIANT) return -1;
    if (b.variant === DEFAULT_VARIANT) return 1;
    return a.variant < b.variant ? -1 : 1;
  });
}

export function activeOf(row: TemplateRow): ActiveView | null {
  const type = row.sms_template_type;
  if (
    row.sms_sign_name === null ||
    row.sms_template_code === null ||
    row.sms_preview_text === null ||
    type === null ||
    !TYPES.has(type)
  ) {
    return null;
  }
  return {
    sign_name: row.sms_sign_name,
    template_code: row.sms_template_code,
    template_type: type as SmsTemplateType,
    preview_text: row.sms_preview_text,
    enabled_at: row.updated_at.toISOString(),
  };
}

export function pendingOf(row: TemplateRow): PendingView | null {
  const type = row.sms_pending_template_type;
  const status = row.sms_test_status;
  if (
    row.sms_pending_sign_name === null ||
    row.sms_pending_template_code === null ||
    row.sms_pending_preview_text === null ||
    row.sms_tested_at === null ||
    type === null ||
    !TYPES.has(type) ||
    status === null ||
    !STATUSES.has(status)
  ) {
    return null;
  }
  const testedAt = row.sms_tested_at.toISOString();
  return {
    sign_name: row.sms_pending_sign_name,
    template_code: row.sms_pending_template_code,
    template_type: type as SmsTemplateType,
    preview_text: row.sms_pending_preview_text,
    saved_at: (row.sms_pending_saved_at ?? row.sms_tested_at).toISOString(),
    test: { status: status as SmsTestStatus, tested_at: testedAt },
  };
}

export function traitsOf(code: string, rows: readonly TemplateRow[]): CodeTraits {
  const primary = primaryRow(rows);
  const definition = definitionOf(code);
  const category: NotifyCategory = isCategory(primary.category) ? primary.category : 'service';
  const channels = orderedChannels(primary.channels);
  const defaultChannels =
    definition === undefined ? channels : orderedChannels(definition.defaultChannels);
  const inboxOnly = definition?.inboxOnly === true;
  const smsFixed = definition?.smsFixed === true;
  const pushSwitchable = !inboxOnly && defaultChannels.includes('inbox');
  const smsSwitchable = !inboxOnly && category === 'service' && !smsFixed;
  const canSms = smsFixed || smsSwitchable;
  return {
    category,
    channels,
    defaultChannels,
    pushSwitchable,
    smsSwitchable,
    smsFixed,
    smsBillingConfirm: smsSwitchable && !defaultChannels.includes('sms'),
    smsReady: canSms && rows.every((row) => activeOf(row) !== null),
    rowVersion: primary.row_version,
  };
}

/** The item of one code; `rows` are all of its notify_templates rows (at least one). */
export function itemOf(
  code: string,
  rows: readonly TemplateRow[],
  context: { readonly fundTerms: boolean; readonly codeTtlSec: number },
): ItemView {
  const traits = traitsOf(code, rows);
  const canSms = traits.smsFixed || traits.smsSwitchable;
  const fallback = code === VERIFY_CODE && !traits.smsReady;
  let smsState: SmsState = 'disabled';
  if (traits.channels.includes('sms')) {
    smsState = traits.smsReady || fallback ? 'enabled' : 'enabled_not_ready';
  }
  return {
    code,
    category: traits.category,
    default_channels: traits.defaultChannels,
    channels: traits.channels,
    push_switchable: traits.pushSwitchable,
    sms_switchable: traits.smsSwitchable,
    sms_fixed: traits.smsFixed,
    sms_billing_confirm: traits.smsBillingConfirm,
    fund_terms: context.fundTerms,
    sms_ready: traits.smsReady,
    sms_state: smsState,
    sms_deploy_fallback: fallback,
    sms_code_ttl_sec: code === VERIFY_CODE ? context.codeTtlSec : null,
    sms_registrations: canSms
      ? sortedRows(rows).map((row) => ({
          variant: row.variant,
          variables: [...variablesOf(code, row.variant)],
          active: activeOf(row),
          pending: pendingOf(row),
        }))
      : [],
    row_version: traits.rowVersion,
  };
}
