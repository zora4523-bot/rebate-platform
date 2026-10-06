// @vitest-environment jsdom
import { expect, it } from 'vitest';
import {
  buildCaseTable,
  paramsForCase,
  selectCases,
} from '../../../../apps/h5/src/entries/conformance/cases.ts';
import {
  blockedLinkVariants,
  caseUrl,
  contract,
  deferred,
  linkPatternHosts,
  mvp,
  normalMethods,
  openAppTarget,
  partial,
  platforms,
  rawContract,
  requiresTap,
  sampleCases,
  shareExampleHosts,
  validParams,
} from './kit.ts';

it('[AC-F1-01d-CASES#1] 用例 ID 唯一、稳定排序，normal 覆盖至少一端支持且有合法目标的方法', () => {
  const rows = buildCaseTable();
  const ids = rows.map((row) => row.id);
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual([...ids].sort());
  expect(buildCaseTable()).toEqual(rows);
  expect(
    rows
      .filter((row) => row.category === 'normal')
      .map((row) => row.method)
      .sort(),
  ).toEqual(normalMethods.map(([method]) => method).sort());
  for (const row of rows) {
    expect(Object.keys(row).sort()).toEqual([
      'category',
      'expect',
      'id',
      'method',
      ...(row.platforms ? ['platforms'] : []),
      'trigger',
    ]);
    const partialMethod = partial.find(([method]) => row.method === method);
    if (partialMethod) {
      const expectedPlatforms = platforms.filter((platform) =>
        row.category === 'unsupported'
          ? row.id === `${row.method}/unsupported/${platform}` &&
            partialMethod[1].since[platform] === null
          : partialMethod[1].since[platform] !== null,
      );
      expect(row.platforms?.slice().sort()).toEqual(expectedPlatforms.sort());
    } else expect(row.platforms).toBeUndefined();
    expect(['auto', 'tap', 'harness']).toContain(row.trigger);
    if (row.id === 'frame/negative/subframe') {
      expect(row).toEqual({
        id: row.id,
        method: 'app.getEnv',
        category: 'negative',
        trigger: 'auto',
        expect: { ok: false },
      });
    } else {
      expect(
        row.id === `${row.method}/${row.category}` ||
          row.id.startsWith(`${row.method}/${row.category}/`),
      ).toBe(true);
      expect(row.expect).not.toEqual({ ok: false });
      if ('code' in row.expect) expect(contract.bridgeErrorCodes).toContain(row.expect.code);
      else expect(row.expect).toEqual({ ok: true });
    }
  }
  expect(rows.filter((row) => row.id === 'frame/negative/subframe')).toHaveLength(1);
});

it.each(mvp)('[AC-F1-01d-CASES#2] %s 的五类覆盖、超时、级别与手势取自契约', (method, meta) => {
  const rows = buildCaseTable().filter(
    (row) => row.method === method && row.id !== 'frame/negative/subframe',
  );
  const normal = rows.filter((row) => row.category === 'normal');
  const hasNormal = method !== 'ext.openApp' || openAppTarget !== undefined;
  expect(normal).toHaveLength(hasNormal ? 1 : 0);
  if (hasNormal) {
    expect(normal[0]).toMatchObject({ id: `${method}/normal`, expect: { ok: true } });
    if (requiresTap(method) || meta.level === 'L2') expect(normal[0]?.trigger).toBe('tap');
  }
  if (
    [
      'app.getEnv',
      'app.getConfig',
      'auth.getUser',
      'auth.getH5Token',
      'perm.getPushStatus',
    ].includes(method)
  ) {
    expect(normal[0]?.trigger).toBe('auto');
  }
  const schema = rawContract.methods[method]!.params;
  if (hasNormal) {
    expect(validParams(schema, paramsForCase(normal[0]!)), `${method}: valid normal params`).toBe(
      true,
    );
    if (method === 'ext.openApp') {
      expect(paramsForCase(normal[0]!)).toMatchObject({ target: openAppTarget });
    }
  }

  const timeout = rows.filter((row) => row.category === 'timeout');
  expect(timeout).toHaveLength(meta.model === 'async' && meta.timeout_ms !== null ? 1 : 0);
  for (const row of timeout) {
    expect(row).toMatchObject({
      id: `${method}/timeout`,
      trigger: 'harness',
      expect: { code: 90003 },
    });
    expect(validParams(schema, paramsForCase(row))).toBe(true);
  }
  const bad = rows.filter((row) => row.category === 'bad_params');
  expect(bad).toHaveLength(Object.keys(schema.properties ?? {}).length > 0 ? 1 : 0);
  for (const row of bad) {
    expect(row).toMatchObject({
      id: `${method}/bad_params`,
      trigger: meta.level === 'L2' || meta.gesture_required ? 'tap' : 'auto',
      expect: { code: 90002 },
    });
    expect(
      validParams(schema, paramsForCase(row)),
      `${method}: bad params must actually violate schema`,
    ).toBe(false);
  }
  const gesture = rows.filter((row) => row.category === 'no_gesture');
  expect(gesture).toHaveLength(meta.level === 'L2' || meta.gesture_required ? 1 : 0);
  for (const row of gesture) {
    expect(row).toMatchObject({
      id: `${method}/no_gesture`,
      trigger: 'auto',
      expect: { code: 90404 },
    });
    expect(validParams(schema, paramsForCase(row))).toBe(true);
  }
  const loggedOut = rows.filter((row) => row.id.endsWith('/negative/logged_out'));
  expect(loggedOut).toHaveLength(meta.level === 'L1' || meta.level === 'L2' ? 1 : 0);
  for (const row of loggedOut) {
    expect(row).toMatchObject({
      category: 'negative',
      trigger: 'harness',
      expect: { code: 90401 },
    });
    expect(validParams(schema, paramsForCase(row))).toBe(true);
  }
});

it('[AC-F1-01d-CASES#3] unsupported 区分全端 P1 与部分端 null since，不能误判支持端', () => {
  const rows = buildCaseTable();
  const unsupported = rows.filter((row) => row.category === 'unsupported');
  const unsupportedPlatforms = partial.flatMap(([method, meta]) =>
    platforms
      .filter((platform) => meta.since[platform] === null)
      .map((platform) => ({ method, platform })),
  );
  expect(unsupported).toHaveLength(deferred.length + unsupportedPlatforms.length + 1);
  const unknown = unsupported.filter((row) => !Object.hasOwn(contract.bridgeMethods, row.method));
  expect(unknown).toHaveLength(1);
  for (const row of unsupported)
    expect(row).toMatchObject({ trigger: 'auto', expect: { code: 90001 } });
  for (const [method] of deferred) {
    expect(rows.filter((row) => row.method === method)).toEqual([
      {
        id: `${method}/unsupported`,
        method,
        category: 'unsupported',
        trigger: 'auto',
        expect: { code: 90001 },
      },
    ]);
  }
  for (const { method, platform } of unsupportedPlatforms) {
    expect(unsupported.filter((row) => row.id === `${method}/unsupported/${platform}`)).toEqual([
      {
        id: `${method}/unsupported/${platform}`,
        method,
        category: 'unsupported',
        trigger: 'auto',
        expect: { code: 90001 },
        platforms: [platform],
      },
    ]);
    expect(rows.some((row) => row.id === `${method}/unsupported`)).toBe(false);
  }
});

it('[AC-F1-01d-CASES#4] 每个 trade_only 目标有独立 90403 用例且参数满足 schema', () => {
  const rows = buildCaseTable().filter(
    (row) =>
      row.method === 'ext.openApp' &&
      row.category === 'negative' &&
      'code' in row.expect &&
      row.expect.code === 90403,
  );
  const targets = Object.entries(contract.apps)
    .filter(([, app]) => app.trade_only)
    .map(([target]) => target);
  const observed = rows.map((row) => {
    const params = paramsForCase(row);
    expect(validParams(rawContract.methods['ext.openApp']!.params, params)).toBe(true);
    return (params as { target: string }).target;
  });
  expect([...new Set(observed)].sort()).toEqual(targets.sort());
});

it('[AC-F1-01d-CASES#5] 参数样例不伪造平台域名，未登记域名只用 example.com', () => {
  const rows = buildCaseTable();
  const schemes = Object.values(contract.apps)
    .flatMap((app) => [...app.ios_query_schemes, ...app.harmony_query_schemes])
    .map((scheme) => scheme.toLowerCase());
  function visit(value: unknown): void {
    if (typeof value === 'string' && /^[a-z][a-z0-9+.]*:\/\//i.test(value)) {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        expect(['example.com', ...linkPatternHosts, ...shareExampleHosts]).toContain(
          url.hostname.toLowerCase().replace(/\.$/, ''),
        );
      } else expect(schemes).toContain(url.protocol.slice(0, -1).toLowerCase());
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) visit(child);
    }
  }
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) visit(paramsForCase(row));
});

it.each(['ext.openBrowser', 'share.open'])(
  '[AC-F1-01d-CASES#6] %s 覆盖 contracts link_patterns 示例及每种 URL 变体',
  (method) => {
    const rows = buildCaseTable().filter(
      (row) =>
        row.method === method &&
        row.category === 'negative' &&
        'code' in row.expect &&
        row.expect.code === 90403,
    );
    expect(linkPatternHosts.length).toBeGreaterThan(0);
    for (const { url, variant } of blockedLinkVariants) {
      const matching = rows.filter((row) => caseUrl(row, paramsForCase(row)) === url);
      expect(matching, `${method}/${variant}: ${url}`).toHaveLength(1);
      expect(validParams(rawContract.methods[method]!.params, paramsForCase(matching[0]!))).toBe(
        true,
      );
    }
  },
);

it('[AC-F1-01d-SELECT#1] 无 cases 参数保留所有行（harness 等待外部选择）', () => {
  expect(selectCases(sampleCases, '?other=1')).toEqual({ cases: sampleCases, unknown_cases: [] });
});

it('[AC-F1-01d-SELECT#2] URL 解码后仅选择列出的 ID，未知 ID 留在 unknown_cases', () => {
  const selected = selectCases(
    sampleCases,
    '?cases=nav.close%2Fnormal,missing,auth.getUser%2Ftimeout',
  );
  expect(selected.cases.map((row) => row.id).sort()).toEqual([
    'auth.getUser/timeout',
    'nav.close/normal',
  ]);
  expect(selected.unknown_cases).toEqual(['missing']);
});

it('[AC-F1-01d-SELECT#3] 显式空 cases 不回落到跑全表', () => {
  expect(selectCases(sampleCases, '?cases=')).toEqual({ cases: [], unknown_cases: [] });
});
