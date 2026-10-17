// 邀请纯函数（B1-11c；BR-INV-01 / 02 / 07）。不读系统时区与系统时钟，时刻一律由调用方传入。
import { accountingDate } from '../calendar/index.ts';

export interface InviterFacts {
  readonly risk_state: 'normal' | 'frozen' | 'appealing' | 'banned';
  readonly deletion_status: 'cooling' | 'processing' | 'done' | 'cancelled' | null;
  readonly phone_bound: boolean;
  /** 调用方仅在已实名且判定时刻未满 18 周岁时传 true；未实名传 false。 */
  readonly verified_minor: boolean;
}

export interface InviteFailWindow {
  readonly day: string;
  readonly retry_after_seconds: number;
}

const MS_PER_SECOND = 1000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const OFFSET_MS = 8 * MS_PER_HOUR;

// Unicode White_Space 全集（含 U+0085、U+3000），另加 JS \s 里的 U+FEFF 与零宽 U+200B–U+200D。
const STRIPPED = /[\p{White_Space}​-‍﻿]/gu;
// BR-INV-01：32 个字符 23456789ABCDEFGHJKLMNPQRSTUVWXYZ（去掉 0/O/1/I），长度恰为 6。
const INVITE_CODE = /^[2-9A-HJ-NP-Z]{6}$/;

const RISK_STATES: Readonly<Record<InviterFacts['risk_state'], boolean>> = {
  normal: false,
  frozen: true,
  appealing: true,
  banned: true,
};
const DELETION_STATUSES: Readonly<Record<NonNullable<InviterFacts['deletion_status']>, boolean>> = {
  cooling: true,
  processing: true,
  done: true,
  cancelled: false,
};

function hasOwn(table: object, key: unknown): key is string {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);
}

function instantOf(value: unknown, name: string): number {
  if (!(value instanceof Date)) {
    throw new RangeError(`${name} must be a Date`);
  }
  const ms = value.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError(`${name} is an invalid Date`);
  }
  return ms;
}

/** NFKC → 删除 Unicode 空白及 U+200B–U+200D、U+FEFF → 大写；空串仍返回空串。 */
export function normalizeInviteCode(input: string): string {
  if (typeof input !== 'string') {
    throw new RangeError('invite code must be a string');
  }
  return input.normalize('NFKC').replace(STRIPPED, '').toUpperCase();
}

/** 只检查已规范化字符串：恰为 6 位，字符集为 23456789ABCDEFGHJKLMNPQRSTUVWXYZ。 */
export function isInviteCodeFormat(code: string): boolean {
  return typeof code === 'string' && INVITE_CODE.test(code);
}

/** BR-INV-02；只消费调用方传入的当前事实，非法枚举抛 RangeError。 */
export function inviterUnavailable(facts: InviterFacts): boolean {
  if (typeof facts !== 'object' || facts === null) {
    throw new RangeError('inviter facts must be an object');
  }
  const { risk_state, deletion_status, phone_bound, verified_minor } = facts;
  if (!hasOwn(RISK_STATES, risk_state)) {
    throw new RangeError(`unknown risk_state ${JSON.stringify(risk_state) ?? 'undefined'}`);
  }
  if (deletion_status !== null && !hasOwn(DELETION_STATUSES, deletion_status)) {
    throw new RangeError(
      `unknown deletion_status ${JSON.stringify(deletion_status) ?? 'undefined'}`,
    );
  }
  if (typeof phone_bound !== 'boolean') {
    throw new RangeError('phone_bound must be a boolean');
  }
  if (typeof verified_minor !== 'boolean') {
    throw new RangeError('verified_minor must be a boolean');
  }
  const riskBlocked = RISK_STATES[risk_state];
  const deletionBlocked = deletion_status !== null && DELETION_STATUSES[deletion_status];
  return riskBlocked || deletionBlocked || !phone_bound || verified_minor;
}

/** hours 为非负整数；保留 createdAt 毫秒精度；非法时间或小时数抛 RangeError。 */
export function inviteBackfillDeadline(createdAt: Date, hours: number): Date {
  const start = instantOf(createdAt, 'createdAt');
  if (typeof hours !== 'number' || !Number.isSafeInteger(hours) || hours < 0) {
    throw new RangeError(`backfill hours must be a non-negative integer, got ${String(hours)}`);
  }
  const end = start + hours * MS_PER_HOUR;
  // eslint-disable-next-line no-restricted-syntax -- 由入参时间值构造，不读墙钟（D10-21）
  const deadline = new Date(end);
  if (!Number.isSafeInteger(end) || !Number.isFinite(deadline.getTime())) {
    throw new RangeError(`backfill deadline overflows the Date range (${String(hours)} hours)`);
  }
  return deadline;
}

/** 严格 now < deadline；非法时间抛 RangeError。 */
export function withinBackfill(now: Date, deadline: Date): boolean {
  return instantOf(now, 'now') < instantOf(deadline, 'deadline');
}

/** +08:00 自然日键及到次日零点向上取整的秒数；非法时间抛 RangeError。 */
export function inviteFailWindow(now: Date): InviteFailWindow {
  const ms = instantOf(now, 'now');
  const day = accountingDate(now);
  const sinceMidnight = (((ms + OFFSET_MS) % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  const remaining = MS_PER_DAY - sinceMidnight;
  const retry_after_seconds = Math.floor((remaining + MS_PER_SECOND - 1) / MS_PER_SECOND);
  return { day, retry_after_seconds };
}
