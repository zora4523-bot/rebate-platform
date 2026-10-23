// Risk rule list helpers (contract CT-24f admin-risk: GET /admin/v1/risk-rules, POST
// …/{rule_id}/enable | …/disable): the console dictionary names of a rule's status and hit action
// (BR-TEXT-25; the code itself while the dictionary has no row), Beijing time, the config-center
// address of a threshold key and the classification of a failed write.
import type { Schema } from '@couli/contracts-ts';
import { AdminApiError } from '../../providers/data/index.ts';

export type RiskRule = Schema<'AdminRiskRule'>;
export type RiskRuleStatus = RiskRule['status'];
/** The two writes of a rule: enable → enabled, disable → disabled. */
export type RiskRuleChange = 'enable' | 'disable';

export const RISK_RULES_URL = '/admin/v1/risk-rules';
export const STEP_UP_URL = '/admin/v1/auth/step-up';
/** The config-center menu (resources/index.ts `config`); thresholds are edited only there. */
export const CONFIG_CENTER_PATH = '/config';
export const REASON_MAX = 200;

interface AdminDictionary {
  readonly texts: Readonly<Record<string, string>>;
}

// The bundled console dictionary (contracts/texts.admin.default.json, BR-TEXT-25). A Vite glob
// keeps the JSON outside this package's TypeScript project while Vite and Vitest inline it.
const loaded = import.meta.glob<AdminDictionary>(
  '../../../../../contracts/texts.admin.default.json',
  { eager: true, import: 'default' },
);
const dictionary: Readonly<Record<string, string>> = Object.values(loaded)[0]?.texts ?? {};

type DictKind = 'risk_rule_status' | 'risk_action';

/** The dictionary name of a code (admin_dict.<kind>.<code>), else the code itself. */
function dictLabel(kind: DictKind, code: string): string {
  const key = `admin_dict.${kind}.${code}`;
  const name = Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
  return name === undefined || name === '' ? code : name;
}

export const statusLabel = (code: string): string => dictLabel('risk_rule_status', code);
export const actionLabel = (code: string): string => dictLabel('risk_action', code);

/** The status a change leads to. */
export function targetOf(change: RiskRuleChange): RiskRuleStatus {
  return change === 'enable' ? 'enabled' : 'disabled';
}

/** The change a row offers: an enabled rule can be disabled, any other one enabled. */
export function changeOf(rule: RiskRule): RiskRuleChange {
  return rule.status === 'enabled' ? 'disable' : 'enable';
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** YYYY-MM-DD HH:mm in Beijing time whatever the host zone; unreadable input is shown as is. */
export function beijingTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const date = new Date(ms + BEIJING_OFFSET_MS);
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

/** Config-center address of one configuration item: /config?item=<key>. */
export function configItemTarget(key: string): { pathname: string; search: string } {
  return { pathname: CONFIG_CENTER_PATH, search: `?${new URLSearchParams({ item: key })}` };
}

/** The request body: the listed version and the reason only when one was typed. */
export function changeRequest(
  rule: RiskRule,
  reason: string,
): Schema<'AdminRiskRuleStatusChangeRequest'> {
  return {
    expected_version: rule.version,
    ...(reason.trim() === '' ? {} : { reason }),
  };
}

export function fieldsOf(error: AdminApiError): readonly unknown[] {
  const data = error.data;
  if (typeof data === 'object' && data !== null && 'fields' in data && Array.isArray(data.fields))
    return data.fields as unknown[];
  return [];
}

/**
 * Whether a failed write may still have been applied: no readable answer arrived (network, parse,
 * non-200 envelope), a server error (5xxxx), or an unexpected throw. A refusal the server answered
 * (10003, 10403, 20001, 20902 …) or a request rejected before sending means not applied.
 */
export function writeOutcomeUnknown(cause: unknown): boolean {
  if (!(cause instanceof AdminApiError)) return true;
  if (cause.kind === 'request') return false;
  if (cause.kind !== 'api') return true;
  return cause.code >= 50000;
}
