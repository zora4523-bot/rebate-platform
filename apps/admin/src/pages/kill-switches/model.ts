// Display rules of the emergency switches page. Everything that decides behaviour (which rows
// exist, default, permissions, admin_editable, version) comes from the server row; this file only
// derives labels and the client-side gate (BR-WDR-30: the auto payout switch is turned off only).
import type { Schema } from '@couli/contracts-ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { killSwitchesTexts as t } from '../../texts/kill-switches.ts';

export type SwitchRow = Schema<'AdminKillSwitch'>;
export type SwitchValue = SwitchRow['default'];

/** Turning it on needs the owner's confirmation (another flow); the console offers off only. */
export const AUTO_PAYOUT = 'withdraw.auto_payout.enabled';

/** Group of a key by its first segment, in the page order of t.groups. */
export function groupOf(key: string): number {
  const head = key.split('.')[0] ?? '';
  if (head === 'convert' || head === 'search' || head === 'parse' || head === 'pdd') return 0;
  if (head === 'agent') return 1;
  if (head === 'withdraw' || head === 'payout' || head === 'pay') return 2;
  return 3;
}

function lookup(map: Readonly<Record<string, string>>, code: string): string {
  return Object.hasOwn(map, code) ? (map[code] ?? code) : code;
}

/** Business name of a key, or null when the page has none (the key is shown alone). */
export function nameOf(key: string): string | null {
  if (Object.hasOwn(t.names, key)) return t.names[key] ?? null;
  const parts = key.split('.');
  const [a, b, c, d] = parts;
  if (parts.length === 3 && c !== undefined) {
    const platform = lookup(t.platforms, c);
    if (a === 'convert' && b === 'enabled') return t.patternNames.convert(platform);
    if (a === 'convert' && b === 'off_reason') return t.patternNames.offReason(platform);
    if (a === 'search' && b === 'enabled') return t.patternNames.search(platform);
    if (a === 'credit' && b === 'enabled') return t.patternNames.credit(platform);
    if (a === 'watch' && b === 'enabled') return t.patternNames.watch(platform);
    if (a === 'payout' && b === 'channel_enabled')
      return t.patternNames.payoutChannel(lookup(t.payoutChannels, c));
    if (a === 'payout' && b === 'channel_paused')
      return t.patternNames.payoutPaused(lookup(t.payoutChannels, c));
    if (a === 'pay' && b === 'channel_enabled')
      return t.patternNames.payChannel(lookup(t.payChannels, c));
  }
  if (parts.length === 4 && a === 'agent' && b === 'tools' && c !== undefined && d === 'enabled')
    return t.patternNames.tool(c);
  return null;
}

export function displayName(key: string): string {
  return nameOf(key) ?? key;
}

/** What pausing or turning on the switch does, or null when the page has no line for it. */
export function impactOf(key: string): string | null {
  if (Object.hasOwn(t.impacts, key)) return t.impacts[key] ?? null;
  const parts = key.split('.');
  const [a, b, c] = parts;
  if (parts.length === 3 && c !== undefined) {
    const platform = lookup(t.platforms, c);
    if (a === 'convert' && b === 'enabled') return t.patternImpacts.convert(platform);
    if (a === 'convert' && b === 'off_reason') return t.patternImpacts.offReason(platform);
    if (a === 'search' && b === 'enabled') return t.patternImpacts.search(platform);
    if (a === 'credit' && b === 'enabled') return t.patternImpacts.credit(platform);
    if (a === 'payout' && b === 'channel_enabled')
      return t.patternImpacts.payoutChannel(lookup(t.payoutChannels, c));
    if (a === 'payout' && b === 'channel_paused') return t.patternImpacts.payoutPaused;
    if (a === 'pay' && b === 'channel_enabled')
      return t.patternImpacts.payChannel(lookup(t.payChannels, c));
  }
  if (parts.length === 4 && a === 'agent' && b === 'tools') return t.patternImpacts.tool;
  return null;
}

/** The value in force: the written value, or the registered default when never written. */
export function currentOf(row: SwitchRow): SwitchValue {
  return row.value ?? row.default;
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** True when a written value differs from the registered default. */
export function differs(row: SwitchRow): boolean {
  // A null default (no registered value, e.g. a route object) has nothing to compare with.
  return row.value !== null && row.default !== null && !same(row.value, row.default);
}

function isPausedKind(key: string): boolean {
  return key.split('.').some((segment) => segment.endsWith('paused'));
}

/** Whether changing the row to `next` stops something (pause, turn off): shown as danger. */
export function isStopping(row: SwitchRow, next: SwitchValue): boolean {
  if (typeof next !== 'boolean') return false;
  return isPausedKind(row.key) ? next : !next;
}

/** Business label of a boolean value of this row. */
export function booleanLabel(row: SwitchRow, value: boolean): string {
  if (isPausedKind(row.key)) return value ? t.state.paused : t.state.normal;
  if (row.key === 'agent.whitelist_only') return value ? t.state.whitelist : t.state.everyone;
  if (value) return t.state.open;
  if (row.default === true) return t.state.paused;
  return row.key.startsWith('convert.enabled.') ? t.state.notOpen : t.state.notEnabled;
}

/** Label of the target state in the confirmation: turning an enabled switch off is a pause. */
export function targetLabel(row: SwitchRow, value: SwitchValue): string {
  if (typeof value === 'boolean') {
    if (!value && !isPausedKind(row.key) && row.key !== 'agent.whitelist_only')
      return t.state.paused;
    return booleanLabel(row, value);
  }
  return valueLabel(value);
}

/** Readable form of a non-boolean value (enum option, route object). */
export function valueLabel(value: SwitchValue): string {
  if (value === null) return t.dash;
  if (typeof value === 'string') return enumLabel(value);
  if (typeof value === 'object' && !Array.isArray(value))
    return Object.entries(value)
      .map(
        ([name, item]) =>
          `${lookup(t.routeLabels, name)} ${typeof item === 'string' ? item : JSON.stringify(item)}`,
      )
      .join(' · ');
  return JSON.stringify(value) ?? t.dash;
}

export function enumLabel(option: string): string {
  return Object.hasOwn(t.enumLabels, option) ? `${t.enumLabels[option]} ${option}` : option;
}

/** Label of any value of this row (boolean by business meaning). */
export function stateLabel(row: SwitchRow, value: SwitchValue): string {
  return typeof value === 'boolean' ? booleanLabel(row, value) : valueLabel(value);
}

/** Raw value as the confirmation's reference line shows it (on / off, option, JSON). */
export function rawLabel(value: SwitchValue): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? t.dash;
}

/** Verb of changing the row to `next`. */
export function verbOf(row: SwitchRow, next: SwitchValue): string {
  if (typeof next !== 'boolean') return t.verb.change;
  if (row.key === AUTO_PAYOUT) return next ? t.verb.enable : t.verb.close;
  if (isPausedKind(row.key)) return next ? t.verb.pause : t.verb.resume;
  if (!next) return t.verb.pause;
  return row.key.startsWith('convert.enabled.') ? t.verb.open : t.verb.enable;
}

/** Whether the account holds any permission point the server listed for the row. */
export function permitted(row: SwitchRow, access: AccessControl): boolean {
  return row.permissions.some((permission) => access.can(permission));
}

/**
 * Whether the account may change the row at all: server says editable, one of its permission
 * points is held, and the auto payout switch only while it is on (it can only be turned off).
 */
export function changeable(row: SwitchRow, access: AccessControl): boolean {
  if (!row.admin_editable || row.value_type === 'object' || !permitted(row, access)) return false;
  if (row.key === AUTO_PAYOUT) return currentOf(row) === true;
  return true;
}

/** Whether `next` may be sent for the row (never true for the auto payout switch). */
export function allowedTarget(row: SwitchRow, next: SwitchValue): boolean {
  if (row.key === AUTO_PAYOUT) return next === false;
  if (row.value_type === 'boolean') return typeof next === 'boolean';
  if (row.value_type === 'enum')
    return typeof next === 'string' && (row.options ?? []).includes(next);
  return false;
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** YYYY-MM-DD HH:mm in Beijing time; unreadable input is shown as is. */
export function beijingTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const date = new Date(ms + BEIJING_OFFSET_MS);
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

/**
 * Whether a failed PUT may still have been applied: no readable answer arrived (network, parse,
 * non-200 envelope), a server error (5xxxx), or an unexpected throw. A refusal the server answered
 * (10003, 10403, 20001, 20902, 42901 …) or a request rejected before sending means not applied.
 */
export function writeOutcomeUnknown(cause: unknown): boolean {
  if (!(cause instanceof AdminApiError)) return true;
  if (cause.kind === 'request') return false;
  if (cause.kind !== 'api') return true;
  return cause.code >= 50000;
}
