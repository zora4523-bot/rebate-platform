// B2-08c (规划/08 BR-WDR-20; 拍板第二批 FUND-04; task §9.2 1, §9.3 纯函数 / 配置缺省): the
// FeeTaxCalculator built by createFeeTaxCalculator over content's configuration port, for the methods
// that read nothing but the three keys (none, flat_rate; cumulative is in calculator.int.test.ts).
//   tax.SERVICE_FEE.method     none | flat_rate | cumulative, missing → none (FUND-04);
//   tax.SERVICE_FEE.rate_bp    JSON integer 0..10000, missing → 0;
//   tax.SERVICE_FEE.rate_table missing → [].
// A missing row is its default without a warning; an invalid value is its default with a warning,
// never a throw. fee 0 (BR-WDR-19 MVP), net = amount − tax, tax_rule_version =
// taxRuleVersion(effective configuration). The handle given is one the none / flat_rate paths must
// never use. Each test builds the calculator first (red: the skeleton's NotImplemented).
// Top-level it() only (规划/11 §4.3).
import { propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  createFeeTaxCalculator,
  taxRuleVersion,
} from '../../../../apps/api/src/modules/payout/application/fee-tax-calculator.ts';
import {
  NO_HANDLE,
  NOW,
  TABLE,
  TABLE_JSON,
  TAX_KEYS,
  actor,
  fixedConfig,
  recordingLogger,
  roundHalfUp,
} from './kit.ts';

const APP = 'taxcalc_unit';
const PROPERTY_TIMEOUT_MS: number = Math.max(30_000, Math.ceil(propRuns() * 0.3));
const IDENTITY = {
  readIdentityKey: () => Promise.resolve('a'.repeat(64)),
};

function build(values: Readonly<Record<string, unknown>>, app = APP) {
  const logger = recordingLogger();
  const config = fixedConfig(app, values);
  const calculator = createFeeTaxCalculator({ config: config.port, identityKey: IDENTITY, logger });
  const quote = (amountFen: bigint) =>
    calculator.calculate(NO_HANDLE, { ...actor(APP), amountFen, now: NOW });
  return { calculator, logger, quote };
}

it('[AC-B2-08c#default] 三键都没有（无种子）→ 等同 none：税 0、手续费 0、到账 = 金额，版本 = 缺省配置的版本，不告警', async () => {
  const { logger, quote } = build({});
  const result = await quote(12_300n);
  expect(result.fee_fen).toBe(0n);
  expect(result.tax_fen).toBe(0n);
  expect(result.net_fen).toBe(12_300n);
  expect(result.tax_rule_version).toBe(
    taxRuleVersion({ method: 'none', rate_bp: 0n, rate_table: [] }),
  );
  expect(logger.warn).not.toHaveBeenCalled();
});

it('[AC-B2-08c#none] method=none：即使配了税率与税率表，税仍为 0、到账 = 金额；版本固化当时的配置', async () => {
  const { logger, quote } = build({
    [TAX_KEYS.method]: 'none',
    [TAX_KEYS.rateBp]: 2000,
    [TAX_KEYS.rateTable]: TABLE_JSON,
  });
  const result = await quote(1_000_000n);
  expect(result.tax_fen).toBe(0n);
  expect(result.fee_fen).toBe(0n);
  expect(result.net_fen).toBe(1_000_000n);
  expect(result.tax_rule_version).toBe(
    taxRuleVersion({ method: 'none', rate_bp: 2000n, rate_table: TABLE }),
  );
  expect(logger.warn).not.toHaveBeenCalled();
});

it('[AC-B2-08c#flat] 08 例：flat_rate 2000bp，申请 ¥100 → 税 2000 分、到账 8000 分、手续费 0；版本 = (flat_rate, 2000, []) 的版本', async () => {
  const { logger, quote } = build({ [TAX_KEYS.method]: 'flat_rate', [TAX_KEYS.rateBp]: 2000 });
  const result = await quote(10_000n);
  expect(result.fee_fen).toBe(0n);
  expect(result.tax_fen).toBe(2_000n);
  expect(result.net_fen).toBe(8_000n);
  expect(result.tax_rule_version).toBe(
    taxRuleVersion({ method: 'flat_rate', rate_bp: 2000n, rate_table: [] }),
  );
  expect(logger.warn).not.toHaveBeenCalled();
});

it('[AC-B2-08c#flat] flat_rate 四舍五入到分：25 分 × 20% = 5；1 分 × 50% = 0.5 → 1；3 分 × 15% = 0.45 → 0', async () => {
  const twenty = build({ [TAX_KEYS.method]: 'flat_rate', [TAX_KEYS.rateBp]: 2000 });
  expect((await twenty.quote(25n)).tax_fen).toBe(5n);
  const half = build({ [TAX_KEYS.method]: 'flat_rate', [TAX_KEYS.rateBp]: 5000 });
  const one = await half.quote(1n);
  expect(one.tax_fen).toBe(1n);
  expect(one.net_fen).toBe(0n);
  const fifteen = build({ [TAX_KEYS.method]: 'flat_rate', [TAX_KEYS.rateBp]: 1500 });
  const three = await fifteen.quote(3n);
  expect(three.tax_fen).toBe(0n);
  expect(three.net_fen).toBe(3n);
});

it(
  '[AC-B2-08c#flat] 任意金额与 0..10000bp：税 = round_half_up(amount × bp / 10000)，0 ≤ 税 ≤ 金额，到账 = 金额 − 税',
  async () => {
    // The calculator is built per run; the first build already meets the skeleton.
    build({ [TAX_KEYS.method]: 'flat_rate', [TAX_KEYS.rateBp]: 2000 });
    const arb = fc.tuple(
      fc.bigInt({ min: 1n, max: 10n ** 12n }),
      fc.integer({ min: 0, max: 10000 }),
    );
    const details = await fc.check(
      fc.asyncProperty(arb, async ([amount, rate]) => {
        const { quote } = build({ [TAX_KEYS.method]: 'flat_rate', [TAX_KEYS.rateBp]: rate });
        const result = await quote(amount);
        const tax = roundHalfUp(amount, BigInt(rate), 10000n);
        return (
          result.tax_fen === tax &&
          result.fee_fen === 0n &&
          result.net_fen === amount - tax &&
          tax >= 0n &&
          tax <= amount
        );
      }),
      propParams(),
    );
    expect(details.failed ? String(details.counterexample) : null).toBeNull();
  },
  PROPERTY_TIMEOUT_MS,
);

it.each([
  ['FLAT_RATE'],
  ['progressive'],
  [''],
  [1],
  [null],
  [true],
  [['flat_rate']],
  [{ method: 'flat_rate' }],
] as const)(
  '[AC-B2-08c#invalid] method 非法（%j）→ 按缺省 none：税 0，告警而不抛；版本 = 生效配置 (none, 2000, []) 的版本',
  async (method) => {
    const { logger, quote } = build({ [TAX_KEYS.method]: method, [TAX_KEYS.rateBp]: 2000 });
    const result = await quote(10_000n);
    expect(result.tax_fen).toBe(0n);
    expect(result.net_fen).toBe(10_000n);
    expect(result.tax_rule_version).toBe(
      taxRuleVersion({ method: 'none', rate_bp: 2000n, rate_table: [] }),
    );
    expect(logger.warn).toHaveBeenCalled();
  },
);

it.each([[10001], [-1], [20.5], ['2000'], [null], [[2000]]] as const)(
  '[AC-B2-08c#invalid] flat_rate 下 rate_bp 非法（%j）→ 按缺省 0：税 0，告警而不抛；版本 = (flat_rate, 0, []) 的版本',
  async (rate) => {
    const { logger, quote } = build({ [TAX_KEYS.method]: 'flat_rate', [TAX_KEYS.rateBp]: rate });
    const result = await quote(10_000n);
    expect(result.tax_fen).toBe(0n);
    expect(result.net_fen).toBe(10_000n);
    expect(result.tax_rule_version).toBe(
      taxRuleVersion({ method: 'flat_rate', rate_bp: 0n, rate_table: [] }),
    );
    expect(logger.warn).toHaveBeenCalled();
  },
);

it('[AC-B2-08c#appid] 只读本 app 的配置：别的 app 配了 flat_rate 2000bp，本 app 仍是缺省 none（税 0）', async () => {
  const { quote } = build({ [TAX_KEYS.method]: 'flat_rate', [TAX_KEYS.rateBp]: 2000 }, 'other_app');
  const result = await quote(10_000n);
  expect(result.tax_fen).toBe(0n);
  expect(result.tax_rule_version).toBe(
    taxRuleVersion({ method: 'none', rate_bp: 0n, rate_table: [] }),
  );
});

it('[AC-B2-08c#version] 同一配置两次计算、两个计算器 → 同一版本；改税率或改方法 → 版本不同', async () => {
  const flat = { [TAX_KEYS.method]: 'flat_rate', [TAX_KEYS.rateBp]: 2000 };
  const a = await build(flat).quote(10_000n);
  const again = build(flat);
  const b = await again.quote(10_000n);
  const c = await again.quote(20_000n);
  const higher = await build({ ...flat, [TAX_KEYS.rateBp]: 2500 }).quote(10_000n);
  const none = await build({ ...flat, [TAX_KEYS.method]: 'none' }).quote(10_000n);
  expect(typeof a.tax_rule_version).toBe('string');
  expect(b.tax_rule_version).toBe(a.tax_rule_version);
  expect(c.tax_rule_version).toBe(a.tax_rule_version);
  expect(higher.tax_rule_version).not.toBe(a.tax_rule_version);
  expect(none.tax_rule_version).not.toBe(a.tax_rule_version);
  expect(none.tax_rule_version).not.toBe(higher.tax_rule_version);
});
