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

/** 每个平台的组合槽位数：L1–L3 × self/share。 */
const SLOTS_PER_PLATFORM = LEVELS.length * ORDER_TYPES.length;

function levelIndex(value: unknown): number {
  return value === 'L1' ? 0 : value === 'L2' ? 1 : value === 'L3' ? 2 : -1;
}

function orderTypeIndex(value: unknown): number {
  return value === 'self' ? 0 : value === 'share' ? 1 : -1;
}

function inRange(value: unknown, max: bigint): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= max;
}

function show(value: unknown): string {
  return typeof value === 'bigint' ? `${value.toString()}n` : `${typeof value}`;
}

const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?\+08:00$/;
const OFFSET_SECONDS = 8 * 3600;

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
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const localSeconds = daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second;
  return localSeconds - OFFSET_SECONDS;
}

/**
 * BR-CALC-05/06/07/11：校验完整草稿，不读取时钟、不做 I/O、不改输入。
 * 返回全部拒绝原因，不抛错、不截断；相同输入的错误内容及顺序稳定。
 * 行错误携带 platform/level/order_type，预留错误携带 platform，合计错误
 * 携带 platform/order_type。时间字符串须合法且带 +08:00，不归一化非法日期。
 * 错误按类别输出：规则维度 → 预留维度 → 预留范围 → 单项比例 → 间推开关 →
 * 活动加成 → 合计上限 → 生效时间；同类内按输入或平台清单顺序。
 * 实现上规则行与预留行各只遍历一次，按类别分桶后再按上述顺序拼接。
 */
export function validateRuleVersion(input: ValidateRuleVersionInput): ValidateRuleVersionResult {
  const { draft } = input;
  const indirectEnabled = draft.indirect_enabled;
  const errors: RuleVersionValidationError[] = [];

  // commission.platforms 去重，保留首次出现的顺序；下标用于组合槽位与 (平台, 订单类型) 分组。
  const platforms: string[] = [];
  const platformIndex = new Map<string, number>();
  for (const platform of input.platforms) {
    if (!platformIndex.has(platform)) {
      platformIndex.set(platform, platforms.length);
      platforms.push(platform);
    }
  }
  const platformCount = platforms.length;
  const groupCount = platformCount * ORDER_TYPES.length;

  // 规则行一次遍历：维度错误、单项比例、间推开关分桶，同时累计组合次数与每组各项最大值。
  // 各项最大值从 0 起算（负值已单独报错，不得拉低合计）；关闭间推时间推项按 0 计（BR-CALC-05）。
  const ruleCounts = new Array<number>(platformCount * SLOTS_PER_PLATFORM).fill(0);
  const maxOwn = new Array<bigint>(groupCount).fill(0n);
  const maxDirect = new Array<bigint>(groupCount).fill(0n);
  const maxIndirect = new Array<bigint>(groupCount).fill(0n);
  const ratioErrors: RuleVersionValidationError[] = [];
  const indirectErrors: RuleVersionValidationError[] = [];
  for (const row of draft.rules) {
    const p = platformIndex.get(row.platform);
    if (p === undefined) {
      errors.push({
        code: 'UNKNOWN_PLATFORM',
        platform: row.platform,
        level: row.level,
        order_type: row.order_type,
        detail: `规则行平台 ${row.platform} 不在 commission.platforms 中`,
      });
    } else {
      const l = levelIndex(row.level);
      const o = orderTypeIndex(row.order_type);
      if (l < 0 || o < 0) {
        errors.push({
          code: 'UNKNOWN_PLATFORM',
          platform: row.platform,
          level: row.level,
          order_type: row.order_type,
          detail: `规则行 ${row.platform} 的等级 ${String(row.level)} 或订单类型 ${String(row.order_type)} 不在 L1–L3 × self/share 中`,
        });
      } else {
        ruleCounts[p * SLOTS_PER_PLATFORM + l * ORDER_TYPES.length + o]! += 1;
        const g = p * ORDER_TYPES.length + o;
        const own: unknown = row.r_own_bp;
        const direct: unknown = row.r_direct_bp;
        if (typeof own === 'bigint' && own > maxOwn[g]!) maxOwn[g] = own;
        if (typeof direct === 'bigint' && direct > maxDirect[g]!) maxDirect[g] = direct;
        if (indirectEnabled) {
          const indirect: unknown = row.r_indirect_bp;
          if (typeof indirect === 'bigint' && indirect > maxIndirect[g]!) maxIndirect[g] = indirect;
        }
      }
    }

    // BR-CALC-07：单项 0–8000，每个字段单独报告。
    for (const field of RATIO_FIELDS) {
      const value: unknown = row[field];
      if (!inRange(value, RATIO_MAX_BP)) {
        ratioErrors.push({
          code: 'RATIO_OUT_OF_RANGE',
          platform: row.platform,
          level: row.level,
          order_type: row.order_type,
          detail: `${row.platform}/${row.level}/${row.order_type} 的 ${field}=${show(value)} 超出 0–8000`,
        });
      }
    }

    // BR-CALC-05：关闭间推的版本 r_indirect_bp 必须全为 0。
    if (!indirectEnabled && row.r_indirect_bp !== 0n) {
      indirectErrors.push({
        code: 'INDIRECT_DISABLED',
        platform: row.platform,
        level: row.level,
        order_type: row.order_type,
        detail: `indirect_enabled=false 但 ${row.platform}/${row.level}/${row.order_type} 的 r_indirect_bp=${show(row.r_indirect_bp)}`,
      });
    }
  }

  // BR-CALC-06：规则维度——缺组合、重复组合（按平台清单 × 等级 × 订单类型的顺序）。
  const duplicateRuleErrors: RuleVersionValidationError[] = [];
  for (let p = 0; p < platformCount; p += 1) {
    const platform = platforms[p]!;
    for (let l = 0; l < LEVELS.length; l += 1) {
      const level = LEVELS[l]!;
      for (let o = 0; o < ORDER_TYPES.length; o += 1) {
        const count = ruleCounts[p * SLOTS_PER_PLATFORM + l * ORDER_TYPES.length + o]!;
        if (count === 1) continue;
        const order_type = ORDER_TYPES[o]!;
        if (count === 0) {
          errors.push({
            code: 'MISSING_RULE',
            platform,
            level,
            order_type,
            detail: `缺少比例行 ${platform}/${level}/${order_type}`,
          });
        } else {
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
  for (const error of duplicateRuleErrors) errors.push(error);

  // BR-CALC-06：预留维度——未配置平台、缺平台、重复平台；同一遍历收集 BR-CALC-02 范围错误。
  const reserveCounts = new Array<number>(platformCount).fill(0);
  const reserveRangeErrors: RuleVersionValidationError[] = [];
  for (const row of draft.reserves) {
    const p = platformIndex.get(row.platform);
    if (p === undefined) {
      errors.push({
        code: 'UNKNOWN_PLATFORM',
        platform: row.platform,
        detail: `预留行平台 ${row.platform} 不在 commission.platforms 中`,
      });
    } else {
      reserveCounts[p]! += 1;
    }
    // BR-CALC-02/06：预留比例 0–10000。
    if (!inRange(row.reserve_bp, RESERVE_MAX_BP)) {
      reserveRangeErrors.push({
        code: 'RESERVE_OUT_OF_RANGE',
        platform: row.platform,
        detail: `平台 ${row.platform} 的 reserve_bp=${show(row.reserve_bp)} 超出 0–10000`,
      });
    }
  }
  const duplicateReserveErrors: RuleVersionValidationError[] = [];
  for (let p = 0; p < platformCount; p += 1) {
    const count = reserveCounts[p]!;
    if (count === 1) continue;
    const platform = platforms[p]!;
    if (count === 0) {
      errors.push({
        code: 'MISSING_RESERVE',
        platform,
        detail: `缺少平台 ${platform} 的 reserve_bp`,
      });
    } else {
      duplicateReserveErrors.push({
        code: 'DUPLICATE_RESERVE',
        platform,
        detail: `平台 ${platform} 的 reserve_bp 出现 ${count} 次`,
      });
    }
  }
  for (const error of duplicateReserveErrors) errors.push(error);
  for (const error of reserveRangeErrors) errors.push(error);
  for (const error of ratioErrors) errors.push(error);
  for (const error of indirectErrors) errors.push(error);

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
  for (let p = 0; p < platformCount; p += 1) {
    for (let o = 0; o < ORDER_TYPES.length; o += 1) {
      const g = p * ORDER_TYPES.length + o;
      const own = maxOwn[g]!;
      const direct = maxDirect[g]!;
      const indirect = maxIndirect[g]!;
      const total = own + direct + indirect + bonusForTotal;
      if (total > RATIO_MAX_BP) {
        const platform = platforms[p]!;
        const order_type = ORDER_TYPES[o]!;
        errors.push({
          code: 'TOTAL_RATIO_EXCEEDED',
          platform,
          order_type,
          detail: `${platform}/${order_type} 合计 max r_own_bp ${own} + max r_direct_bp ${direct} + max r_indirect_bp ${indirect} + activity_bonus_bp ${bonusForTotal} = ${total} > 8000`,
        });
      }
    }
  }

  // BR-CALC-11：effective_from ≥ publish_at，且严格大于所有已发布未撤销版本（到秒）。
  // 每个时刻在一次调用内只解析一次。
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
  const blocking: string[] = [];
  for (const text of input.published_effective_froms) {
    const seconds = parseInstantSeconds(text);
    if (seconds === null) {
      errors.push({
        code: 'INVALID_PUBLISHED_EFFECTIVE_FROM',
        detail: `已发布版本 effective_from=${JSON.stringify(text)} 不是合法的 ISO 8601 +08:00 时刻`,
      });
    } else if (effective !== null && seconds >= effective) {
      blocking.push(text);
    }
  }
  if (effective !== null && publishAt !== null && effective < publishAt) {
    errors.push({
      code: 'EFFECTIVE_BEFORE_PUBLISH',
      detail: `effective_from=${draft.effective_from} 早于发布时刻 ${input.publish_at}`,
    });
  }
  if (blocking.length > 0) {
    errors.push({
      code: 'EFFECTIVE_NOT_INCREASING',
      detail: `effective_from=${draft.effective_from} 未严格大于已发布未撤销版本 ${blocking.join('、')}`,
    });
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
