// B1-12z · Use cases of the console's notification channel page (CT-24t: adminListNotifyChannels,
// adminSwitchNotifyChannels, adminRegisterNotifySms, adminRetestNotifySms, adminEnableNotifySms,
// adminDiscardNotifySms; 08 BR-TEXT-20 细则「短信渠道登记与后台渠道开关」, BR-ID-45, BR-ID-05;
// orchestrator rulings D10-335, D10-337, D10-339, D10-341, D10-342).
//
// The controller has already passed the operation guard (permission point, totp step-up where the
// operation has one) and hands the raw path, query and body over: every further check runs here
// in the contract's order, and the first failing one is the answer (NotifyFieldsError → 20001,
// NotifyConflictError → 20902, NotifyVerifyPhoneMissingError → 10003, NotifyTestNotAcceptedError
// → 50301 / 50401 after the failed test was saved). A fund code's registration and enabling also
// need content.fund_terms: `access.requireFundTerms()` rejects with the guard's 10403.
//
// Writes check the code's row_version on an unlocked read first (for the order of the answers,
// and so a stale page never sends a test SMS), then write under the same version in one
// conditional UPDATE after the provider answered (./store.ts): when the code changed meanwhile
// the call answers 20902 and keeps nothing, whatever the test SMS's outcome.
//
// Pure module (no decorators, erasable syntax).
import type { AuditInput, Clock } from '../../platform/index.ts';
import {
  DEFAULT_VARIANT,
  VERIFY_CODE,
  definedVariablesOf,
  lockedTemplateType,
  sampleOf,
  variablesOf,
  type NotifyChannel,
} from './catalog.ts';
import { previewProblem } from './preview.ts';
import type { NotifySmsTestResult, NotifySmsTestSender } from './sms-test-sender.ts';
import type { TemplateStore } from './store.ts';
import {
  activeOf,
  itemOf,
  orderedChannels,
  pendingOf,
  traitsOf,
  type ItemView,
  type TemplateRow,
} from './view.ts';

export const NOTIFY_LOCKED = 'notify_channel_locked';

/** At least one character that is not white space (JavaScript \s plus U+0085, as the CHECKs). */
const VISIBLE = /[^\s\u0085]/;
const TEXT_FIELDS = ['sign_name', 'template_code', 'preview_text'] as const;

export const NOTIFY_AUDIT_ACTIONS = Object.freeze({
  switch: 'notify_channel_switch',
  register: 'notify_sms_register',
  discard: 'notify_sms_discard',
  test: 'notify_sms_test',
  enable: 'notify_sms_enable',
});

/** 20001 with data.fields (and data.reason when the contract names one). */
export class NotifyFieldsError extends Error {
  readonly fields: readonly string[];
  readonly reason: string | null;

  constructor(fields: readonly string[], reason: string | null = null) {
    super(`notify channels: invalid ${fields.join(', ')}`);
    this.name = 'NotifyFieldsError';
    this.fields = fields;
    this.reason = reason;
  }
}

/** 20902 without data: the code's row_version moved on. */
export class NotifyConflictError extends Error {
  constructor() {
    super('notify channels: row_version moved on');
    this.name = 'NotifyConflictError';
  }
}

/** 10003 data {tier: totp, reason: verify_phone_missing}: a retest without a verify phone. */
export class NotifyVerifyPhoneMissingError extends Error {
  constructor() {
    super('notify channels: no verify phone for the test SMS');
    this.name = 'NotifyVerifyPhoneMissingError';
  }
}

/** 50301 (rejected) / 50401 (unknown): the failed test is already saved. */
export class NotifyTestNotAcceptedError extends Error {
  readonly result: Exclude<NotifySmsTestResult, 'accepted'>;

  constructor(result: Exclude<NotifySmsTestResult, 'accepted'>) {
    super(`notify channels: test SMS ${result}`);
    this.name = 'NotifyTestNotAcceptedError';
    this.result = result;
  }
}

export interface NotifyActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface NotifyFundAccess {
  /** Resolves when the account holds content.fund_terms; rejects with the guard's 10403. */
  requireFundTerms(): Promise<void>;
}

/** Contract request validation: the offending fields, or null when valid (values coerced). */
export type RequestValidator = (value: unknown) => readonly string[] | null;

export interface NotifyValidators {
  readonly switchBody: RequestValidator;
  readonly registerQuery: RequestValidator;
  readonly registerBody: RequestValidator;
  readonly retestQuery: RequestValidator;
  readonly retestBody: RequestValidator;
  readonly enableQuery: RequestValidator;
  readonly enableBody: RequestValidator;
  readonly discardQuery: RequestValidator;
}

export interface NotifyVerifyPhones {
  /** The account's verify phone (BR-ID-45), null when none is registered. */
  read(account: { readonly appId: string; readonly adminId: string }): Promise<string | null>;
}

export interface NotifyChannelsDeps {
  readonly store: () => TemplateStore;
  readonly clock: Clock;
  readonly sender: NotifySmsTestSender;
  readonly verifyPhones: () => NotifyVerifyPhones;
  readonly validators: NotifyValidators;
  /** BR-TEXT-12 细则「资金术语键」 classification of a template code (content's list). */
  readonly isFundCode: (code: string) => boolean;
  /** BR-TEXT-13 forbidden words found in a text (content's list). */
  readonly bannedWords: (text: string) => readonly string[];
  /** BR-ID-05 validity of the six-digit code, in seconds. */
  readonly codeTtlSec: number;
}

export interface SmsResultView {
  readonly item: ItemView;
  readonly test_send_phone_masked: string | null;
}

interface SwitchBody {
  readonly push?: boolean;
  readonly sms?: boolean;
  readonly confirm_sms_billing?: boolean;
  readonly row_version: number;
}

interface RegisterBody {
  readonly sign_name: string;
  readonly template_code: string;
  readonly template_type: 'verify' | 'notice';
  readonly preview_text: string;
  readonly sample?: Readonly<Record<string, string>>;
  readonly row_version: number;
}

interface RetestBody {
  readonly sample?: Readonly<Record<string, string>>;
  readonly row_version: number;
}

interface VersionBody {
  readonly row_version: number;
}

interface Registration {
  readonly sign_name: string;
  readonly template_code: string;
  readonly template_type: string;
  readonly preview_text: string;
}

/** BR-ID-33 display mask of an 11-digit mainland number; anything else one "*" per character. */
export function maskPhone(phone: string): string {
  return /^1[0-9]{10}$/.test(phone)
    ? `${phone.slice(0, 3)}****${phone.slice(7)}`
    : '*'.repeat([...phone].length);
}

function testStatus(result: NotifySmsTestResult): 'accepted' | 'failed' {
  return result === 'accepted' ? 'accepted' : 'failed';
}

function byText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function plainObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function checked<T>(validator: RequestValidator, value: unknown): T {
  const fields = validator(value);
  if (fields !== null) throw new NotifyFieldsError(fields);
  return value as T;
}

function registrationOf(view: Registration | null): Registration | null {
  if (view === null) return null;
  return {
    sign_name: view.sign_name,
    template_code: view.template_code,
    template_type: view.template_type,
    preview_text: view.preview_text,
  };
}

export class NotifyChannelsAdmin {
  readonly #deps: NotifyChannelsDeps;

  constructor(deps: NotifyChannelsDeps) {
    this.#deps = deps;
  }

  /** adminListNotifyChannels: one item per code of the app, by code. */
  async list(appId: string): Promise<{ items: ItemView[] }> {
    const rows = await this.#deps.store().appRows(appId);
    const byCode = new Map<string, TemplateRow[]>();
    for (const row of rows) {
      const group = byCode.get(row.code) ?? [];
      group.push(row);
      byCode.set(row.code, group);
    }
    const codes = [...byCode.keys()].sort(byText);
    return { items: codes.map((code) => this.#item(code, byCode.get(code) ?? [])) };
  }

  /** adminSwitchNotifyChannels. */
  async switchChannels(actor: NotifyActor, code: string, body: unknown): Promise<ItemView> {
    const rows = await this.#rows(actor.appId, code);
    const request = checked<SwitchBody>(this.#deps.validators.switchBody, body);
    if (request.push === undefined && request.sms === undefined) {
      throw new NotifyFieldsError(['push', 'sms']);
    }
    const traits = traitsOf(code, rows);
    if (request.push !== undefined && !traits.pushSwitchable) {
      throw new NotifyFieldsError(['push'], NOTIFY_LOCKED);
    }
    if (request.sms !== undefined && !traits.smsSwitchable) {
      throw new NotifyFieldsError(['sms'], NOTIFY_LOCKED);
    }
    const smsOn = traits.channels.includes('sms');
    if (request.sms === true && !smsOn) {
      if (!traits.smsReady) throw new NotifyFieldsError(['sms']);
      if (traits.smsBillingConfirm && request.confirm_sms_billing !== true) {
        throw new NotifyFieldsError(['confirm_sms_billing']);
      }
    }
    if (request.row_version !== traits.rowVersion) throw new NotifyConflictError();

    const next = new Set<NotifyChannel>(traits.channels);
    if (request.push !== undefined) {
      if (request.push) next.add('push');
      else next.delete('push');
    }
    if (request.sms !== undefined) {
      if (request.sms) next.add('sms');
      else next.delete('sms');
    }
    const channels = orderedChannels([...next]);
    if (channels.join() === traits.channels.join()) return this.#item(code, rows);

    await this.#write(actor, code, rows, request.row_version, {
      channels,
      audit: {
        action: NOTIFY_AUDIT_ACTIONS.switch,
        target: code,
        before: { code, channels: traits.channels },
        after: {
          code,
          channels,
          confirm_sms_billing: request.confirm_sms_billing === true,
        },
      },
    });
    return this.#item(code, await this.#deps.store().codeRows(actor.appId, code));
  }

  /** adminRegisterNotifySms. */
  async register(
    actor: NotifyActor,
    code: string,
    query: unknown,
    body: unknown,
    access: NotifyFundAccess,
  ): Promise<SmsResultView> {
    const rows = await this.#rows(actor.appId, code);
    const fund = this.#deps.isFundCode(code);
    if (fund) await access.requireFundTerms();
    const traits = traitsOf(code, rows);
    if (!traits.smsFixed && !traits.smsSwitchable) {
      throw new NotifyFieldsError(['code'], NOTIFY_LOCKED);
    }
    const row = this.#variantRow(rows, query);
    // A variant the code defines no SMS variables for cannot get a registration (no fallback).
    const variables = definedVariablesOf(code, row.variant);
    if (variables === undefined) throw new NotifyFieldsError(['variant']);
    checked(this.#deps.validators.registerQuery, plainObject(query));
    const request = checked<RegisterBody>(this.#deps.validators.registerBody, body);
    // notify_templates keeps no blank registration text (the same white space as its CHECKs).
    const blank = TEXT_FIELDS.filter((field) => !VISIBLE.test(request[field]));
    if (blank.length > 0) throw new NotifyFieldsError(blank);
    this.#checkSample(request.sample, variables);
    if (request.template_type !== lockedTemplateType(code)) {
      throw new NotifyFieldsError(['template_type']);
    }
    const problem = previewProblem({
      text: request.preview_text,
      variables,
      signName: request.sign_name,
      codeTtlSec: code === VERIFY_CODE ? this.#deps.codeTtlSec : null,
      bannedWords: this.#deps.bannedWords,
    });
    if (problem !== undefined) {
      if ('reason' in problem) throw new NotifyFieldsError(['preview_text'], problem.reason);
      throw new NotifyFieldsError(['preview_text', ...problem.words]);
    }
    if (request.row_version !== traits.rowVersion) throw new NotifyConflictError();

    const now = this.#deps.clock.now();
    const active = activeOf(row);
    const pending = pendingOf(row);
    const target = `${code}:${row.variant}`;
    const registration: Registration = {
      sign_name: request.sign_name,
      template_code: request.template_code,
      template_type: request.template_type,
      preview_text: request.preview_text,
    };
    if (
      active !== null &&
      active.sign_name === request.sign_name &&
      active.template_code === request.template_code
    ) {
      // The registration in use, edited in place: no test SMS, the pending one stays as it is.
      await this.#write(actor, code, rows, request.row_version, {
        variant: {
          name: row.variant,
          set: {
            sms_template_type: request.template_type,
            sms_preview_text: request.preview_text,
            updated_at: now,
          },
        },
        audit: {
          action: NOTIFY_AUDIT_ACTIONS.register,
          target,
          before: { code, variant: row.variant, fund_terms: fund, active: registrationOf(active) },
          after: {
            code,
            variant: row.variant,
            fund_terms: fund,
            active: registration,
            verify_phone_masked: null,
            test_result: null,
          },
        },
      });
      return { item: await this.#current(actor.appId, code), test_send_phone_masked: null };
    }

    // A new signature or template CODE: saved as pending and test-sent to the operator's own
    // verify phone (none → saved without a send, D10-339 ⑤).
    const phone = await this.#deps.verifyPhones().read(actor);
    let result: NotifySmsTestResult | null = null;
    if (phone !== null) {
      result = await this.#send({
        appId: actor.appId,
        phone,
        signName: request.sign_name,
        templateCode: request.template_code,
        params: this.#params(variables, request.sample),
      });
    }
    const status = result === null ? 'not_sent_no_verify_phone' : testStatus(result);
    const masked = phone === null ? null : maskPhone(phone);
    await this.#write(actor, code, rows, request.row_version, {
      variant: {
        name: row.variant,
        set: {
          sms_pending_sign_name: request.sign_name,
          sms_pending_template_code: request.template_code,
          sms_pending_template_type: request.template_type,
          sms_pending_preview_text: request.preview_text,
          sms_test_status: status,
          sms_tested_at: this.#deps.clock.now(),
        },
      },
      audit: {
        action: NOTIFY_AUDIT_ACTIONS.register,
        target,
        before: {
          code,
          variant: row.variant,
          fund_terms: fund,
          pending: registrationOf(pending),
        },
        after: {
          code,
          variant: row.variant,
          fund_terms: fund,
          pending: registration,
          verify_phone_masked: masked,
          test_result: status,
        },
      },
    });
    if (result !== null && result !== 'accepted') throw new NotifyTestNotAcceptedError(result);
    return { item: await this.#current(actor.appId, code), test_send_phone_masked: masked };
  }

  /** adminRetestNotifySms. */
  async retest(
    actor: NotifyActor,
    code: string,
    query: unknown,
    body: unknown,
  ): Promise<SmsResultView> {
    const rows = await this.#rows(actor.appId, code);
    const row = this.#variantRow(rows, query);
    checked(this.#deps.validators.retestQuery, plainObject(query));
    const request = checked<RetestBody>(this.#deps.validators.retestBody, body);
    const variables = variablesOf(code, row.variant);
    this.#checkSample(request.sample, variables);
    const pending = pendingOf(row);
    if (pending === null) throw new NotifyFieldsError(['variant']);
    if (request.row_version !== traitsOf(code, rows).rowVersion) throw new NotifyConflictError();
    const phone = await this.#deps.verifyPhones().read(actor);
    if (phone === null) throw new NotifyVerifyPhoneMissingError();

    const result = await this.#send({
      appId: actor.appId,
      phone,
      signName: pending.sign_name,
      templateCode: pending.template_code,
      params: this.#params(variables, request.sample),
    });
    const status = testStatus(result);
    const masked = maskPhone(phone);
    await this.#write(actor, code, rows, request.row_version, {
      variant: {
        name: row.variant,
        set: { sms_test_status: status, sms_tested_at: this.#deps.clock.now() },
      },
      audit: {
        action: NOTIFY_AUDIT_ACTIONS.test,
        target: `${code}:${row.variant}`,
        before: {
          code,
          variant: row.variant,
          template_code: pending.template_code,
          test_result: pending.test.status,
        },
        after: {
          code,
          variant: row.variant,
          template_code: pending.template_code,
          verify_phone_masked: masked,
          test_result: status,
        },
      },
    });
    if (result !== 'accepted') throw new NotifyTestNotAcceptedError(result);
    return { item: await this.#current(actor.appId, code), test_send_phone_masked: masked };
  }

  /** adminEnableNotifySms. */
  async enable(
    actor: NotifyActor,
    code: string,
    query: unknown,
    body: unknown,
    access: NotifyFundAccess,
  ): Promise<ItemView> {
    const rows = await this.#rows(actor.appId, code);
    const fund = this.#deps.isFundCode(code);
    if (fund) await access.requireFundTerms();
    const row = this.#variantRow(rows, query);
    checked(this.#deps.validators.enableQuery, plainObject(query));
    const request = checked<VersionBody>(this.#deps.validators.enableBody, body);
    const pending = pendingOf(row);
    if (pending === null || pending.test.status !== 'accepted') {
      throw new NotifyFieldsError(['variant']);
    }
    if (request.row_version !== traitsOf(code, rows).rowVersion) throw new NotifyConflictError();

    await this.#write(actor, code, rows, request.row_version, {
      variant: {
        name: row.variant,
        set: {
          sms_sign_name: pending.sign_name,
          sms_template_code: pending.template_code,
          sms_template_type: pending.template_type,
          sms_preview_text: pending.preview_text,
          sms_pending_sign_name: null,
          sms_pending_template_code: null,
          sms_pending_template_type: null,
          sms_pending_preview_text: null,
          sms_test_status: null,
          sms_tested_at: null,
          updated_at: this.#deps.clock.now(),
        },
      },
      audit: {
        action: NOTIFY_AUDIT_ACTIONS.enable,
        target: `${code}:${row.variant}`,
        before: {
          code,
          variant: row.variant,
          fund_terms: fund,
          active: registrationOf(activeOf(row)),
        },
        after: { code, variant: row.variant, fund_terms: fund, active: registrationOf(pending) },
      },
    });
    return this.#current(actor.appId, code);
  }

  /** adminDiscardNotifySms. */
  async discard(actor: NotifyActor, code: string, query: unknown): Promise<ItemView> {
    const rows = await this.#rows(actor.appId, code);
    const row = this.#variantRow(rows, query);
    const request = checked<VersionBody>(this.#deps.validators.discardQuery, plainObject(query));
    if (request.row_version !== traitsOf(code, rows).rowVersion) throw new NotifyConflictError();
    const pending = pendingOf(row);
    if (pending === null) return this.#item(code, rows);

    await this.#write(actor, code, rows, request.row_version, {
      variant: {
        name: row.variant,
        set: {
          sms_pending_sign_name: null,
          sms_pending_template_code: null,
          sms_pending_template_type: null,
          sms_pending_preview_text: null,
          sms_test_status: null,
          sms_tested_at: null,
        },
      },
      audit: {
        action: NOTIFY_AUDIT_ACTIONS.discard,
        target: `${code}:${row.variant}`,
        before: {
          code,
          variant: row.variant,
          pending: registrationOf(pending),
          test_result: pending.test.status,
        },
        after: { code, variant: row.variant, pending: null },
      },
    });
    return this.#current(actor.appId, code);
  }

  /** The code's rows; none → 20001 [code]. */
  async #rows(appId: string, code: string): Promise<TemplateRow[]> {
    const rows = await this.#deps.store().codeRows(appId, code);
    if (rows.length === 0) throw new NotifyFieldsError(['code']);
    return rows;
  }

  /** The row of the query's variant (default when absent); not a variant → 20001 [variant]. */
  #variantRow(rows: readonly TemplateRow[], query: unknown): TemplateRow {
    const given = plainObject(query)['variant'];
    const variant = given === undefined ? DEFAULT_VARIANT : given;
    const row = rows.find((candidate) => candidate.variant === variant);
    if (row === undefined) throw new NotifyFieldsError(['variant']);
    return row;
  }

  #checkSample(
    sample: Readonly<Record<string, string>> | undefined,
    variables: readonly string[],
  ): void {
    if (sample === undefined) return;
    if (Object.keys(sample).some((name) => !variables.includes(name))) {
      throw new NotifyFieldsError(['sample']);
    }
  }

  #params(
    variables: readonly string[],
    sample: Readonly<Record<string, string>> | undefined,
  ): Record<string, string> {
    return Object.fromEntries(variables.map((name) => [name, sampleOf(name, sample ?? {})]));
  }

  async #send(message: Parameters<NotifySmsTestSender['send']>[0]): Promise<NotifySmsTestResult> {
    try {
      return await this.#deps.sender.send(message);
    } catch {
      // A sender that failed after the request may have sent it: the outcome is unknown.
      return 'unknown';
    }
  }

  async #write(
    actor: NotifyActor,
    code: string,
    rows: readonly TemplateRow[],
    expected: number,
    change: {
      readonly channels?: readonly string[];
      readonly variant?: Parameters<TemplateStore['write']>[0]['variant'];
      readonly audit: {
        readonly action: string;
        readonly target: string;
        readonly before: Record<string, unknown>;
        readonly after: Record<string, unknown>;
      };
    },
  ): Promise<void> {
    const written = await this.#deps.store().write({
      appId: actor.appId,
      code,
      expected,
      rowCount: rows.length,
      ...(change.channels === undefined ? {} : { channels: change.channels }),
      ...(change.variant === undefined ? {} : { variant: change.variant }),
      audit: {
        actor: actor.adminId,
        action: change.audit.action,
        target: change.audit.target,
        before: change.audit.before as AuditInput['before'],
        after: change.audit.after as AuditInput['after'],
        ip: actor.ip,
      },
    });
    if (!written) throw new NotifyConflictError();
  }

  async #current(appId: string, code: string): Promise<ItemView> {
    return this.#item(code, await this.#rows(appId, code));
  }

  #item(code: string, rows: readonly TemplateRow[]): ItemView {
    return itemOf(code, rows, {
      fundTerms: this.#deps.isFundCode(code),
      codeTtlSec: this.#deps.codeTtlSec,
    });
  }
}
