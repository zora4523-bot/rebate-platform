import { createPropStats, propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import type { ClientPlatform } from '../../../../infra/release-scan/compare/index.ts';
import { ALL_PLATFORMS, FAKE, expectOutcome, hit, realManifest, run } from './fixtures.ts';

// 02 §12.6 公开标识：只有清单登记的类别、且该条目的 platforms 含被扫描的端，命中原文整段符合该类别格式时才放行。
// 只测格式公认、无需平台资料的几类（微信 AppID、Sentry DSN、公钥、服务地址）；其余类别只约束「高熵串不算公开标识」。

function decide(match: string, platform: ClientPlatform, manifestYaml?: string) {
  const report = run([hit({ rule: 'public-id-probe', match })], {
    platform,
    ...(manifestYaml === undefined ? {} : { manifestYaml }),
  });
  expect(report.decisions).toHaveLength(1);
  const d = report.decisions[0];
  // 单条命中：整体结论必须与这一条的判定一致（放行 → 0，阻断 → 1）。
  const allowed = d?.verdict === 'allow' ? 1 : 0;
  expectOutcome(report, { exit_code: allowed === 1 ? 0 : 1, allowed, blocked: 1 - allowed }, match);
  return d;
}

it('[02 §12.6 公开标识#1] 微信 AppID 在 ios/android/harmony 放行，依据为清单条目 wechat_app_id', () => {
  for (const platform of ['ios', 'android', 'harmony'] as const) {
    expect(decide(FAKE.wxAppId, platform)).toMatchObject({
      verdict: 'allow',
      reason: 'public_id',
      basis: 'wechat_app_id',
    });
  }
});

it('[02 §12.6 公开标识#2] 微信 AppID 出现在 h5、admin 制品里阻断（该条目 platforms 不含这两端）', () => {
  for (const platform of ['h5', 'admin'] as const) {
    expect(decide(FAKE.wxAppId, platform)).toMatchObject({
      verdict: 'block',
      reason: 'unlisted',
      basis: null,
    });
  }
});

it('[02 §12.6 公开标识#3] 格式要整段匹配：AppID 前后多出字符、或 wx 后接 32 位十六进制都不算公开标识', () => {
  for (const match of [`${FAKE.wxAppId}0`, `x${FAKE.wxAppId}`, `wx${FAKE.hex32}`]) {
    expect(decide(match, 'ios')).toMatchObject({ verdict: 'block', reason: 'unlisted' });
  }
});

it('[02 §12.6 公开标识#4] 清单删去 wechat 条目后，同一 AppID 在 ios 也阻断（放行只认清单登记）', () => {
  const text = realManifest();
  const start = text.indexOf('  - id: wechat_app_id');
  const end = text.indexOf('  - id: bundle_identity');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const without = text.slice(0, start) + text.slice(end);
  expect(decide(FAKE.wxAppId, 'ios', without)).toMatchObject({
    verdict: 'block',
    reason: 'unlisted',
  });
});

it('[02 §12.6 公开标识#5] Sentry DSN 在 h5 放行（crash_report_endpoint），在 admin 阻断', () => {
  expect(decide(FAKE.sentryDsn, 'h5')).toMatchObject({
    verdict: 'allow',
    reason: 'public_id',
    basis: 'crash_report_endpoint',
  });
  expect(decide(FAKE.sentryDsn, 'admin')).toMatchObject({ verdict: 'block', reason: 'unlisted' });
});

it('[02 §12.6 公开标识#6] 带 secret 段的旧式 DSN 不是公开标识，任何端都阻断', () => {
  for (const platform of ALL_PLATFORMS) {
    expect(decide(FAKE.sentryDsnWithSecret, platform)).toMatchObject({ verdict: 'block' });
  }
});

it('[02 §12.6 公开标识#7] PEM 公钥在 ios 放行（config_public_keys），在 h5 阻断', () => {
  expect(decide(FAKE.publicKeyPem, 'ios')).toMatchObject({
    verdict: 'allow',
    reason: 'public_id',
    basis: 'config_public_keys',
  });
  expect(decide(FAKE.publicKeyPem, 'h5')).toMatchObject({ verdict: 'block', reason: 'unlisted' });
});

it('[02 §12.6 公开标识#8] https 服务地址在五端都放行（service_hosts）；带用户名口令的地址任何端都阻断', () => {
  for (const platform of ALL_PLATFORMS) {
    expect(decide(FAKE.apiUrl, platform)).toMatchObject({
      verdict: 'allow',
      reason: 'public_id',
      basis: 'service_hosts',
    });
    expect(decide(FAKE.apiUrlWithUserinfo, platform)).toMatchObject({ verdict: 'block' });
  }
});

/** 属性回调用：不带 expect，只把「恰有一条判定、阻断、且不是按公开标识」合成布尔。 */
function blockedNotPublic(match: string, platform: ClientPlatform, neverAccepted = false): boolean {
  const report = run(
    [hit({ rule: 'generic-high-entropy', match, never_accepted: neverAccepted })],
    {
      platform,
    },
  );
  const d = report.decisions[0];
  return (
    report.decisions.length === 1 &&
    d !== undefined &&
    d.verdict === 'block' &&
    d.reason !== 'public_id' &&
    d.basis === null &&
    report.exit_code === 1 &&
    !report.passed
  );
}

/** 跑属性并在 fc.assert 之外汇总核对：每次生成都执行到了判定（次数与种子经 @couli/testing）。 */
function assertProperty<T>(name: string, arb: fc.Arbitrary<T>, ok: (v: T) => boolean): void {
  const stats = createPropStats(`release-scan:compare:${name}`);
  fc.assert(
    fc.property(arb, (v) => {
      const pass = ok(v);
      stats.hit(pass ? 'blocked' : 'allowed_or_bad');
      return pass;
    }),
    propParams(),
  );
  const record = stats.flush();
  expect(record.hits).toEqual({ blocked: propRuns() });
}

const PLATFORM = fc.constantFrom(...ALL_PLATFORMS);
const chars = (alphabet: string, n: number) =>
  fc
    .array(fc.constantFrom(...alphabet.split('')), { minLength: n, maxLength: n })
    .map((cs) => cs.join(''));
const HEX = '0123456789abcdef';
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** 32 字节无填充 base64url 的末字符只能是低 2 位为 0 的这 16 个。 */
const B64URL_LAST = 'AEIMQUYcgkosw048';

it('[02 §12.6 公开标识#9] 32/40 位小写十六进制串（服务端密钥常见格式）在任何端都不按公开标识放行', () => {
  assertProperty(
    'hex',
    fc.tuple(fc.oneof(chars(HEX, 32), chars(HEX, 40)), PLATFORM),
    ([match, platform]) => blockedNotPublic(match, platform),
  );
  // PROP_RUNS 次随机串 × 五端：默认 10,000 次约 13 秒，超过 Vitest 默认 5 秒（CI #201，2026-10-06）。
}, 900_000);

it('[02 §12.6 公开标识#10] 24–64 位 base64 / base64url 字符的随机串在任何端都不按公开标识放行', () => {
  const alphabet = `${B64URL}+/`;
  assertProperty(
    'mixed',
    fc.tuple(
      fc
        .integer({ min: 24, max: 64 })
        .chain((n) => chars(alphabet, n))
        .filter((s) => /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s)),
      PLATFORM,
    ),
    ([match, platform]) => blockedNotPublic(match, platform),
  );
  // PROP_RUNS 次随机串 × 五端：默认 10,000 次约 13 秒，超过 Vitest 默认 5 秒（CI #201，2026-10-06）。
}, 900_000);

it('[BR-ID-09][02 §12.6 公开标识#11] 43 位无填充 base64url（install_secret 形状的签名材料）任何端都不按公开标识放行', () => {
  assertProperty(
    'b64url43',
    fc.tuple(
      fc.tuple(chars(B64URL, 42), chars(B64URL_LAST, 1)).map(([a, b]) => `${a}${b}`),
      PLATFORM,
      fc.boolean(),
    ),
    ([match, platform, flagged]) => blockedNotPublic(match, platform, flagged),
  );
  // PROP_RUNS 次随机串 × 五端：默认 10,000 次约 13 秒，超过 Vitest 默认 5 秒（CI #201，2026-10-06）。
}, 900_000);

it('[BR-ID-09][02 §12.6 公开标识#12] 含 - 与 _ 、以合法末字符结尾的合成签名材料：未标不可豁免也阻断，标了则原因为 never_accepted', () => {
  // 运行时拼接的合成值（EXAMPLE 字样），不是任何真实密钥。
  const samples = ['-', '_'].flatMap((sep) =>
    [...B64URL_LAST]
      .slice(0, 4)
      .map((last) => `EXAMPLE${sep}sign${sep}${'Ab9'.repeat(10)}${last}`.slice(-43)),
  );
  for (const match of samples) {
    expect(match).toHaveLength(43);
    expect(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(match), match).toBe(true);
    for (const platform of ALL_PLATFORMS) {
      expect(blockedNotPublic(match, platform), `${platform} ${match}`).toBe(true);
      const flagged = run([hit({ rule: 'request-sign-material', match, never_accepted: true })], {
        platform,
      });
      expect(flagged.decisions[0]).toMatchObject({ verdict: 'block', reason: 'never_accepted' });
      expectOutcome(flagged, { exit_code: 1, allowed: 0, blocked: 1 }, `${platform} ${match}`);
    }
  }
});
