// B2-06f rule tests: PAYOUT_MODE (规划/08 BR-WDR-13 "PAYOUT_MODE 默认 dry_run，改为 live 只能由人经生产
// 发布完成"; "非 prod 环境只能走通道沙箱或 dry-run"; 规划/04 §10 PAYOUT_MODE 不进配置表).
import { propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import { afterEach, expect, it, vi } from 'vitest';
import { resolvePayoutMode } from '../../../../apps/api/src/modules/payout/payout-mode.ts';
import { ConfigError } from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  APP_ENVS,
  CREDENTIAL_NAMES,
  LIVE_CREDENTIALS,
  NON_PROD,
  liveEnv,
  thrownBy,
  textOf,
} from './mode-kit.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

it.each(APP_ENVS)(
  '[AC-B2-06f#1] APP_ENV=%s：PAYOUT_MODE 未设或为空即 dry_run，结果不带凭证',
  (appEnv) => {
    expect(resolvePayoutMode(appEnv, {})).toStrictEqual({ mode: 'dry_run' });
    expect(resolvePayoutMode(appEnv, { PAYOUT_MODE: '' })).toStrictEqual({ mode: 'dry_run' });
    expect(resolvePayoutMode(appEnv, { PAYOUT_MODE: undefined })).toStrictEqual({
      mode: 'dry_run',
    });
    // Credentials present in the environment are not picked up by dry_run.
    expect(resolvePayoutMode(appEnv, { ...liveEnv(), PAYOUT_MODE: undefined })).toStrictEqual({
      mode: 'dry_run',
    });
  },
);

it.each(APP_ENVS)('[AC-B2-06f#2] APP_ENV=%s：PAYOUT_MODE=dry_run 即 dry_run', (appEnv) => {
  expect(resolvePayoutMode(appEnv, { PAYOUT_MODE: 'dry_run' })).toStrictEqual({
    mode: 'dry_run',
  });
  expect(resolvePayoutMode(appEnv, { ...liveEnv(), PAYOUT_MODE: 'dry_run' })).toStrictEqual({
    mode: 'dry_run',
  });
});

it.each(NON_PROD)(
  '[AC-B2-06f#3] APP_ENV=%s：PAYOUT_MODE=live 即使凭证齐全也拒绝启动（ConfigError）',
  (appEnv) => {
    const error = thrownBy(() => resolvePayoutMode(appEnv, liveEnv()));
    expect(error).toBeInstanceOf(ConfigError);
  },
);

it('[AC-B2-06f#4] APP_ENV=prod、PAYOUT_MODE=live、四个凭证齐全：live，凭证按原值返回', () => {
  expect(resolvePayoutMode('prod', liveEnv())).toStrictEqual({
    mode: 'live',
    credentials: LIVE_CREDENTIALS,
  });
});

it.each(
  CREDENTIAL_NAMES.flatMap((name) =>
    [undefined, '', '   ', '\t\n'].map((value) => ({ name, value })),
  ),
)(
  '[AC-B2-06f#5] APP_ENV=prod、PAYOUT_MODE=live、$name=$value：缺一个凭证即拒绝启动',
  ({ name, value }) => {
    const error = thrownBy(() => resolvePayoutMode('prod', { ...liveEnv(), [name]: value }));
    expect(error).toBeInstanceOf(ConfigError);
  },
);

it.each(['LIVE', 'Live', 'sandbox', 'true', '1', 'dry-run', 'production', 'off'])(
  '[AC-B2-06f#6] PAYOUT_MODE=%j 不是 dry_run / live：任何 APP_ENV 都拒绝启动（不当作 live 也不静默降级）',
  (value) => {
    for (const appEnv of APP_ENVS) {
      const error = thrownBy(() => resolvePayoutMode(appEnv, { ...liveEnv(), PAYOUT_MODE: value }));
      expect(error, `${appEnv} ${value}`).toBeInstanceOf(ConfigError);
    }
  },
);

// The property's runs and seed come from PROP_RUNS / PROP_SEED (@couli/testing); the timeout grows
// with the runs as in test/spec/platform/masking.
const PROPERTY_TIMEOUT_MS: number = Math.max(30_000, Math.ceil(propRuns() * 0.3));

const secret = fc.stringMatching(/^[A-Za-z0-9]{24,48}$/);
const refusedScenario = fc.oneof(
  // live outside prod, all four credentials set
  fc.record({
    appEnv: fc.constantFrom(...NON_PROD),
    missing: fc.constant(null),
    mode: fc.constant('live'),
  }),
  // live in prod, one credential missing
  fc.record({
    appEnv: fc.constant('prod' as const),
    missing: fc.constantFrom(...CREDENTIAL_NAMES),
    mode: fc.constant('live'),
  }),
  // an unknown mode, all four credentials set
  fc.record({
    appEnv: fc.constantFrom(...APP_ENVS),
    missing: fc.constant(null),
    mode: fc.constantFrom('LIVE', 'sandbox', 'production'),
  }),
);
type RefusedScenario = typeof refusedScenario extends fc.Arbitrary<infer T> ? T : never;

/** What resolvePayoutMode throws for the scenario with these synthetic secrets. */
function refusal(
  privateKey: string,
  publicKey: string,
  appId: string,
  scenario: RefusedScenario,
): unknown {
  const env: Record<string, string | undefined> = {
    ...liveEnv({ appId, privateKey, alipayPublicKey: publicKey }),
    PAYOUT_MODE: scenario.mode,
  };
  if (scenario.missing !== null) env[scenario.missing] = undefined;
  return thrownBy(() => resolvePayoutMode(scenario.appEnv, env));
}

/** The first refusal that is no ConfigError or shows a key's value; null when every run holds. */
function leakingRefusal(): unknown {
  const details = fc.check(
    fc.property(
      secret,
      secret,
      secret,
      refusedScenario,
      (privateKey, publicKey, appId, scenario) => {
        const error = refusal(privateKey, publicKey, appId, scenario);
        const text = textOf(error);
        return (
          error instanceof ConfigError && !text.includes(privateKey) && !text.includes(publicKey)
        );
      },
    ),
    propParams(),
  );
  if (!details.failed) return null;
  const example = details.counterexample;
  if (example === null) return { error: String(details.errorInstance) };
  const [privateKey, publicKey, appId, scenario] = example;
  const error = refusal(privateKey, publicKey, appId, scenario);
  const text = textOf(error);
  return {
    scenario,
    configError: error instanceof ConfigError,
    showsPrivateKey: text.includes(privateKey),
    showsPublicKey: text.includes(publicKey),
    thrown: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  };
}

it(
  '[AC-B2-06f#7] 拒绝启动的错误（消息、problems、序列化）不含私钥与支付宝公钥的取值',
  () => {
    expect(leakingRefusal()).toBeNull();
  },
  PROPERTY_TIMEOUT_MS,
);

it('[AC-B2-06f#8] resolvePayoutMode 只看传入的对象：不读 process.env、不改传入对象（冻结的对象也能用）', () => {
  for (const [name, value] of Object.entries(liveEnv())) vi.stubEnv(name, value);
  vi.stubEnv('APP_ENV', 'prod');
  const empty = Object.freeze({});
  expect(resolvePayoutMode('prod', empty)).toStrictEqual({ mode: 'dry_run' });
  expect(empty).toStrictEqual({});

  vi.stubEnv('PAYOUT_MODE', undefined);
  for (const name of CREDENTIAL_NAMES) vi.stubEnv(name, undefined);
  const given = Object.freeze(liveEnv());
  const before = { ...given };
  expect(resolvePayoutMode('prod', given)).toStrictEqual({
    mode: 'live',
    credentials: LIVE_CREDENTIALS,
  });
  expect(given).toStrictEqual(before);
});
