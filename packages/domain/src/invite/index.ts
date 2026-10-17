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

/** NFKC → 删除 Unicode 空白及 U+200B–U+200D、U+FEFF → 大写；空串仍返回空串。 */
export function normalizeInviteCode(input: string): string {
  void input;
  throw new Error('NotImplemented: normalizeInviteCode');
}

/** 只检查已规范化字符串：恰为 6 位，字符集为 23456789ABCDEFGHJKLMNPQRSTUVWXYZ。 */
export function isInviteCodeFormat(code: string): boolean {
  void code;
  throw new Error('NotImplemented: isInviteCodeFormat');
}

/** BR-INV-02；只消费调用方传入的当前事实，非法枚举抛 RangeError。 */
export function inviterUnavailable(facts: InviterFacts): boolean {
  void facts;
  throw new Error('NotImplemented: inviterUnavailable');
}

/** hours 为非负整数；保留 createdAt 毫秒精度；非法时间或小时数抛 RangeError。 */
export function inviteBackfillDeadline(createdAt: Date, hours: number): Date {
  void createdAt;
  void hours;
  throw new Error('NotImplemented: inviteBackfillDeadline');
}

/** 严格 now < deadline；非法时间抛 RangeError。 */
export function withinBackfill(now: Date, deadline: Date): boolean {
  void now;
  void deadline;
  throw new Error('NotImplemented: withinBackfill');
}

/** +08:00 自然日键及到次日零点向上取整的秒数；非法时间抛 RangeError。 */
export function inviteFailWindow(now: Date): InviteFailWindow {
  void now;
  throw new Error('NotImplemented: inviteFailWindow');
}
