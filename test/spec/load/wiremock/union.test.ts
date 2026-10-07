// Rule tests for the union replay stubs of QA-06b (规划/05 QA-06「上游用 WireMock」; 规划/02 §6.2
// 录制回放「test 环境指向 WireMock；场景用 X-Scenario；fixture 目录 fixtures/union-recordings/
// <platform>/<scenario>/」; AGENTS.md hard rule 7: no recording, no union success body). Expected
// values are literals or read straight from the synthetic B1-04c files, never from the code under
// test. Top-level it() only.
import { expect, it } from 'vitest';
import { buildMappings } from '../../../../infra/fault/fault.ts';
import {
  buildLoadImport,
  readUnionRecordings,
  type UnionRecordingInput,
} from '../../../../infra/load/wiremock/stubs.ts';
import {
  PLATFORMS,
  RECORDINGS,
  fixtureRecordings,
  shapeProblems,
  unionProbe,
  wiremock,
} from './kit.ts';

it('[规划/02 §6.2 fixture 目录] readUnionRecordings 读出 fixtures/union-recordings 下三家的 synthetic-smoke，两份 JSON 原样', () => {
  const read = readUnionRecordings(RECORDINGS);
  const key = (r: UnionRecordingInput) => `${r.platform}/${r.scenario}`;
  expect([...read].sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
    fixtureRecordings().sort((a, b) => key(a).localeCompare(key(b))),
  );
  expect(() => readUnionRecordings(`${RECORDINGS}/does-not-exist`)).toThrow();
});

it('[WireMock 映射格式] 导入体可 JSON 往返，每条桩符合 WireMock 3 映射结构，id 唯一且不与 QA-05a 故障桩冲突', () => {
  const { mappings } = buildLoadImport(fixtureRecordings(), {});
  expect(mappings.length).toBeGreaterThan(0);
  expect(JSON.parse(JSON.stringify({ mappings })) as unknown).toEqual({ mappings });
  expect(mappings.flatMap(shapeProblems)).toEqual([]);
  const ids = mappings.map((m) => m.id);
  const faultIds = new Set(
    (['bailian', 'union.taobao', 'union.jd', 'union.pdd'] as const).flatMap((t) =>
      buildMappings(t).map((m) => m.id ?? ''),
    ),
  );
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.filter((id) => faultIds.has(id))).toEqual([]);
});

it.each(PLATFORMS)(
  '[规划/02 §6.2 录制回放] %s：按 replay 客户端发出的请求（/union/<平台> 前缀 + 录制路径、X-Scenario、录制请求体）命中，应答与录制逐字段一致',
  (platform) => {
    const input = fixtureRecordings().find((r) => r.platform === platform) as UnionRecordingInput;
    const serve = wiremock(buildLoadImport(fixtureRecordings(), {}).mappings);
    const hit = serve(unionProbe(input));
    expect(hit === null || hit === 'ambiguous' ? hit : 'stub').toBe('stub');
    if (hit === null || hit === 'ambiguous') return;
    const { status, headers, body, fault } = hit.response;
    expect({
      status,
      headers,
      body,
      fault,
      delay: hit.response.fixedDelayMilliseconds ?? 0,
    }).toEqual({
      status: 200,
      headers: { 'content-type': 'text/plain', 'x-synthetic-label': `synthetic-${platform}` },
      body: `synthetic-response-${platform}`,
      fault: undefined,
      delay: 0,
    });
  },
);

it('[规划/02 §6.2 X-Scenario] 场景头不对、缺失，请求体或路径与录制不同，或平台前缀串了，都不命中联盟回放桩', () => {
  const inputs = fixtureRecordings();
  const serve = wiremock(buildLoadImport(inputs, {}).mappings);
  const jd = unionProbe(inputs.find((r) => r.platform === 'jd') as UnionRecordingInput);
  const variants = {
    otherScenario: { ...jd, headers: { 'X-Scenario': 'other-scenario' } },
    noScenario: { ...jd, headers: {} },
    otherBody: { ...jd, body: 'synthetic-other' },
    otherQuery: { ...jd, url: '/union/jd/synthetic-api/echo?case=other' },
    otherMethod: { ...jd, method: 'GET' },
    noPrefix: { ...jd, url: '/synthetic-api/echo?case=synthetic' },
    otherPlatform: { ...jd, url: '/union/meituan/synthetic-api/echo?case=synthetic' },
  };
  const hits = Object.fromEntries(
    Object.entries(variants).map(([k, probe]) => {
      const hit = serve(probe);
      return [k, hit === null ? null : hit === 'ambiguous' ? hit : hit.name];
    }),
  );
  expect(hits).toEqual({
    otherScenario: null,
    noScenario: null,
    otherBody: null,
    otherQuery: null,
    otherMethod: null,
    noPrefix: null,
    otherPlatform: null,
  });
});

it('[AGENTS.md 硬规则 7] 没有录制就没有联盟成功桩：任何 /union/ 路径都不会得到 2xx 或带响应体的应答', () => {
  const { mappings } = buildLoadImport([], {});
  const union = mappings.filter((m) =>
    [m.request.url, m.request.urlPath, m.request.urlPathPattern].some((p) =>
      p?.startsWith('/union'),
    ),
  );
  expect(
    union.filter((m) => {
      const s = m.response.status ?? 0;
      return (s >= 200 && s < 300) || (m.response.body ?? '') !== '';
    }),
  ).toEqual([]);
});

it('[规划/11 §4.5 provenance] provenance 不合法或录制信封不合 B1-04c 格式时拒绝生成，不猜一个应答', () => {
  const base = () => fixtureRecordings().filter((r) => r.platform === 'taobao');
  const bad: Record<string, UnionRecordingInput[]> = {
    unknownSource: base().map((r) => ({
      ...r,
      provenance: { ...(r.provenance as object), source: 'handwritten' },
    })),
    missingSha: base().map((r) => {
      const { originalSha256: _drop, ...rest } = r.provenance as Record<string, unknown>;
      void _drop;
      return { ...r, provenance: rest };
    }),
    extraEnvelopeKey: base().map((r) => ({
      ...r,
      recording: { ...(r.recording as object), proxyBaseUrl: 'http://127.0.0.1:1' },
    })),
    noResponseBody: base().map((r) => {
      const rec = r.recording as { request: unknown; response: Record<string, unknown> };
      return { ...r, recording: { request: rec.request, response: { status: 200, headers: {} } } };
    }),
    unsafeScenario: base().map((r) => ({ ...r, scenario: '../escape' })),
  };
  const outcome = Object.fromEntries(
    Object.entries(bad).map(([k, inputs]) => {
      try {
        buildLoadImport(inputs, {});
        return [k, 'built'];
      } catch (e) {
        return [k, String(e).includes('NotImplemented') ? 'not-implemented' : 'rejected'];
      }
    }),
  );
  expect(outcome).toEqual({
    unknownSource: 'rejected',
    missingSha: 'rejected',
    extraEnvelopeKey: 'rejected',
    noResponseBody: 'rejected',
    unsafeScenario: 'rejected',
  });
});
