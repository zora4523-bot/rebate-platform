export interface RuleVersionRow {
  readonly platform: string;
  readonly level: 'L1' | 'L2' | 'L3';
  readonly order_type: 'self' | 'share';
  readonly r_own_bp: bigint;
  readonly r_direct_bp: bigint;
  readonly r_indirect_bp: bigint;
}

export interface RuleVersionReserve {
  readonly platform: string;
  readonly reserve_bp: bigint;
}

export interface RuleVersionDraft {
  readonly indirect_enabled: boolean;
  /** ISO 8601 +08:00；比较精度到秒。 */
  readonly effective_from: string;
  readonly rules: readonly RuleVersionRow[];
  readonly reserves: readonly RuleVersionReserve[];
}

export interface ValidateRuleVersionInput {
  readonly draft: RuleVersionDraft;
  /** 调用方传入 commission.platforms，不能硬编码当前平台清单。 */
  readonly platforms: readonly string[];
  /** 调用方经 Clock 取得的 ISO 8601 +08:00 时刻。 */
  readonly publish_at: string;
  /** 调用方只传已发布且未撤销版本；包含尚未生效版本，顺序不限。 */
  readonly published_effective_froms: readonly string[];
  /** MVP 不传时为 0；非零值也须计入每组上限。 */
  readonly activity_bonus_bp?: bigint;
}

/** 纯函数的内部诊断标识，不是 HTTP 错误码；接口映射由后续契约任务定义。 */
export type RuleVersionValidationCode =
  | 'MISSING_RULE'
  | 'DUPLICATE_RULE'
  | 'UNKNOWN_PLATFORM'
  | 'MISSING_RESERVE'
  | 'DUPLICATE_RESERVE'
  | 'RATIO_OUT_OF_RANGE'
  | 'RESERVE_OUT_OF_RANGE'
  | 'ACTIVITY_BONUS_OUT_OF_RANGE'
  | 'TOTAL_RATIO_EXCEEDED'
  | 'INDIRECT_DISABLED'
  | 'INVALID_EFFECTIVE_FROM'
  | 'INVALID_PUBLISH_AT'
  | 'INVALID_PUBLISHED_EFFECTIVE_FROM'
  | 'EFFECTIVE_BEFORE_PUBLISH'
  | 'EFFECTIVE_NOT_INCREASING';

export interface RuleVersionValidationError {
  readonly code: RuleVersionValidationCode;
  readonly platform?: string;
  readonly level?: RuleVersionRow['level'];
  readonly order_type?: RuleVersionRow['order_type'];
  /** 可定位的原因说明；单项比例错误须包含字段名，不约定文案。 */
  readonly detail: string;
}

export type ValidateRuleVersionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly RuleVersionValidationError[] };

const LEVELS = ['L1', 'L2', 'L3'] as const;
const ORDER_TYPES = ['self', 'share'] as const;
const RATIO_FIELDS = ['r_own_bp', 'r_direct_bp', 'r_indirect_bp'] as const;

/** BR-CALC-07：单项与每 (平台, 订单类型) 合计的上限；BR-CALC-02：预留上限。 */
const RATIO_MAX_BP = 8000n;
const RESERVE_MAX_BP = 10000n;

type Level = RuleVersionRow['level'];
type OrderType = RuleVersionRow['order_type'];

function isLevel(value: unknown): value is Level {
  return LEVELS.some((level) => level === value);
}

function isOrderType(value: unknown): value is OrderType {
  return ORDER_TYPES.some((orderType) => orderType === value);
}

function inRange(value: unknown, max: bigint): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= max;
}

function show(value: unknown): string {
  return typeof value === 'bigint' ? `${value.toString()}n` : `${typeof value}`;
}

function key(platform: string, level: string, orderType: string): string {
  return JSON.stringify([platform, level, orderType]);
}

const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?\+08:00$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** 公历日期到 1970-01-01 的天数（Howard Hinnant days_from_civil，全整数）。 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * BR-CALC-11：只接受带 +08:00 偏移的 ISO 8601 时刻，返回 UTC 整数秒（小数秒截掉，
 * 比较精度到秒）；格式或日期非法返回 null，不做归一化。不读时钟、不用 Date。
 */
export function parseInstantSeconds(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const match = ISO_PATTERN.exec(text);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const localSeconds = daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second;
  return localSeconds - 8 * 3600;
}

/**
 * BR-CALC-05/06/07/11：校验完整草稿，不读取时钟、不做 I/O、不改输入。
 * 返回全部拒绝原因，不抛错、不截断；相同输入的错误内容及顺序稳定。
 * 行错误携带 platform/level/order_type，预留错误携带 platform，合计错误
 * 携带 platform/order_type。时间字符串须合法且带 +08:00，不归一化非法日期。
 * 错误按类别输出：规则维度 → 预留维度 → 预留范围 → 单项比例 → 间推开关 →
 * 活动加成 → 合计上限 → 生效时间；同类内按输入或平台清单顺序。
 */
export function validateRuleVersion(input: ValidateRuleVersionInput): ValidateRuleVersionResult {
  const { draft } = input;
  const errors: RuleVersionValidationError[] = [];
  const platforms = [...new Set(input.platforms)];
  const configured = new Set(platforms);

  // BR-CALC-06：规则维度——未配置平台、缺组合、重复组合。
  const ruleCounts = new Map<string, number>();
  const unknownRuleErrors: RuleVersionValidationError[] = [];
  for (const row of draft.rules) {
    if (!configured.has(row.platform)) {
      unknownRuleErrors.push({
        code: 'UNKNOWN_PLATFORM',
        platform: row.platform,
        level: row.level,
        order_type: row.order_type,
        detail: `规则行平台 ${row.platform} 不在 commission.platforms 中`,
      });
      continue;
    }
    if (!isLevel(row.level) || !isOrderType(row.order_type)) {
      unknownRuleErrors.push({
        code: 'UNKNOWN_PLATFORM',
        platform: row.platform,
        level: row.level,
        order_type: row.order_type,
        detail: `规则行 ${row.platform} 的等级 ${String(row.level)} 或订单类型 ${String(row.order_type)} 不在 L1–L3 × self/share 中`,
      });
      continue;
    }
    const k = key(row.platform, row.level, row.order_type);
    ruleCounts.set(k, (ruleCounts.get(k) ?? 0) + 1);
  }
  errors.push(...unknownRuleErrors);
  const duplicateRuleErrors: RuleVersionValidationError[] = [];
  for (const platform of platforms) {
    for (const level of LEVELS) {
      for (const order_type of ORDER_TYPES) {
        const count = ruleCounts.get(key(platform, level, order_type)) ?? 0;
        if (count === 0) {
          errors.push({
            code: 'MISSING_RULE',
            platform,
            level,
            order_type,
            detail: `缺少比例行 ${platform}/${level}/${order_type}`,
          });
        } else if (count > 1) {
          duplicateRuleErrors.push({
            code: 'DUPLICATE_RULE',
            platform,
            level,
            order_type,
            detail: `比例行 ${platform}/${level}/${order_type} 出现 ${count} 次`,
          });
        }
      }
    }
  }
  errors.push(...duplicateRuleErrors);

  // BR-CALC-06：预留维度——未配置平台、缺平台、重复平台。
  const reserveCounts = new Map<string, number>();
  for (const row of draft.reserves) {
    if (!configured.has(row.platform)) {
      errors.push({
        code: 'UNKNOWN_PLATFORM',
        platform: row.platform,
        detail: `预留行平台 ${row.platform} 不在 commission.platforms 中`,
      });
      continue;
    }
    reserveCounts.set(row.platform, (reserveCounts.get(row.platform) ?? 0) + 1);
  }
  const duplicateReserveErrors: RuleVersionValidationError[] = [];
  for (const platform of platforms) {
    const count = reserveCounts.get(platform) ?? 0;
    if (count === 0) {
      errors.push({
        code: 'MISSING_RESERVE',
        platform,
        detail: `缺少平台 ${platform} 的 reserve_bp`,
      });
    } else if (count > 1) {
      duplicateReserveErrors.push({
        code: 'DUPLICATE_RESERVE',
        platform,
        detail: `平台 ${platform} 的 reserve_bp 出现 ${count} 次`,
      });
    }
  }
  errors.push(...duplicateReserveErrors);

  // BR-CALC-02/06：预留比例 0–10000。
  for (const row of draft.reserves) {
    if (!inRange(row.reserve_bp, RESERVE_MAX_BP)) {
      errors.push({
        code: 'RESERVE_OUT_OF_RANGE',
        platform: row.platform,
        detail: `平台 ${row.platform} 的 reserve_bp=${show(row.reserve_bp)} 超出 0–10000`,
      });
    }
  }

  // BR-CALC-07：单项 0–8000，每个字段单独报告。
  for (const row of draft.rules) {
    for (const field of RATIO_FIELDS) {
      const value: unknown = row[field];
      if (!inRange(value, RATIO_MAX_BP)) {
        errors.push({
          code: 'RATIO_OUT_OF_RANGE',
          platform: row.platform,
          level: row.level,
          order_type: row.order_type,
          detail: `${row.platform}/${row.level}/${row.order_type} 的 ${field}=${show(value)} 超出 0–8000`,
        });
      }
    }
  }

  // BR-CALC-05：关闭间推的版本 r_indirect_bp 必须全为 0。
  if (!draft.indirect_enabled) {
    for (const row of draft.rules) {
      if (row.r_indirect_bp !== 0n) {
        errors.push({
          code: 'INDIRECT_DISABLED',
          platform: row.platform,
          level: row.level,
          order_type: row.order_type,
          detail: `indirect_enabled=false 但 ${row.platform}/${row.level}/${row.order_type} 的 r_indirect_bp=${show(row.r_indirect_bp)}`,
        });
      }
    }
  }

  // BR-CALC-07：活动加成单项 0–8000（MVP 不传即 0）。
  const bonus: unknown = input.activity_bonus_bp ?? 0n;
  if (!inRange(bonus, RATIO_MAX_BP)) {
    errors.push({
      code: 'ACTIVITY_BONUS_OUT_OF_RANGE',
      detail: `activity_bonus_bp=${show(bonus)} 超出 0–8000`,
    });
  }
  // 负数或非 bigint 的加成已单独报错，合计里按 0 计，避免抵消其他项。
  const bonusForTotal = typeof bonus === 'bigint' && bonus > 0n ? bonus : 0n;

  // BR-CALC-07：每 (平台, 订单类型) max_等级 三项 + 活动加成 ≤ 8000。
  // 各项最大值从 0 起算（负值已单独报错，不得拉低合计）；关闭间推时间推项按 0 计（BR-CALC-05）。
  for (const platform of platforms) {
    for (const order_type of ORDER_TYPES) {
      let maxOwn = 0n;
      let maxDirect = 0n;
      let maxIndirect = 0n;
      for (const row of draft.rules) {
        if (row.platform !== platform || row.order_type !== order_type || !isLevel(row.level)) {
          continue;
        }
        if (typeof row.r_own_bp === 'bigint' && row.r_own_bp > maxOwn) maxOwn = row.r_own_bp;
        if (typeof row.r_direct_bp === 'bigint' && row.r_direct_bp > maxDirect) {
          maxDirect = row.r_direct_bp;
        }
        if (
          draft.indirect_enabled &&
          typeof row.r_indirect_bp === 'bigint' &&
          row.r_indirect_bp > maxIndirect
        ) {
          maxIndirect = row.r_indirect_bp;
        }
      }
      const total = maxOwn + maxDirect + maxIndirect + bonusForTotal;
      if (total > RATIO_MAX_BP) {
        errors.push({
          code: 'TOTAL_RATIO_EXCEEDED',
          platform,
          order_type,
          detail: `${platform}/${order_type} 合计 max r_own_bp ${maxOwn} + max r_direct_bp ${maxDirect} + max r_indirect_bp ${maxIndirect} + activity_bonus_bp ${bonusForTotal} = ${total} > 8000`,
        });
      }
    }
  }

  // BR-CALC-11：effective_from ≥ publish_at，且严格大于所有已发布未撤销版本（到秒）。
  const effective = parseInstantSeconds(draft.effective_from);
  if (effective === null) {
    errors.push({
      code: 'INVALID_EFFECTIVE_FROM',
      detail: `effective_from=${JSON.stringify(draft.effective_from)} 不是合法的 ISO 8601 +08:00 时刻`,
    });
  }
  const publishAt = parseInstantSeconds(input.publish_at);
  if (publishAt === null) {
    errors.push({
      code: 'INVALID_PUBLISH_AT',
      detail: `publish_at=${JSON.stringify(input.publish_at)} 不是合法的 ISO 8601 +08:00 时刻`,
    });
  }
  for (const text of input.published_effective_froms) {
    if (parseInstantSeconds(text) === null) {
      errors.push({
        code: 'INVALID_PUBLISHED_EFFECTIVE_FROM',
        detail: `已发布版本 effective_from=${JSON.stringify(text)} 不是合法的 ISO 8601 +08:00 时刻`,
      });
    }
  }
  if (effective !== null && publishAt !== null && effective < publishAt) {
    errors.push({
      code: 'EFFECTIVE_BEFORE_PUBLISH',
      detail: `effective_from=${draft.effective_from} 早于发布时刻 ${input.publish_at}`,
    });
  }
  if (effective !== null) {
    const blocking = input.published_effective_froms.filter((text) => {
      const seconds = parseInstantSeconds(text);
      return seconds !== null && seconds >= effective;
    });
    if (blocking.length > 0) {
      errors.push({
        code: 'EFFECTIVE_NOT_INCREASING',
        detail: `effective_from=${draft.effective_from} 未严格大于已发布未撤销版本 ${blocking.join('、')}`,
      });
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
