// Rule tests for the fault scenarios of QA-05a (规划/05 QA-05「故障注入：联盟、百炼……超时」;
// 规划/02 §6.2 录制回放「场景用 X-Scenario」与超时 3 秒 / 10 秒; 规划/02 §14 千问行「超时、429、
// 5xx」). Targets are local fakes only (09 README §0.2 hard rule 5); union stubs carry no success
// body because none has been recorded (AGENTS.md hard rule 7). Top-level it() only.
import { expect, it } from 'vitest';
import {
  buildMappings,
  faultTargets,
  scenariosOf,
  type FaultTarget,
} from '../../../infra/fault/fault.ts';
import {
  ALL_TARGETS,
  FAULTS,
  SAMPLE_PATH,
  SCENARIOS_OF,
  UNION_SCENARIOS,
  UNION_TARGETS,
  answer,
  scenarioProblems,
  serveProblems,
} from './kit.ts';

it('[规划/05 QA-05] 目标只有百炼与三个联盟假上游；百炼支持 normal 与五种故障，联盟只有四种故障', () => {
  expect([...faultTargets()].sort()).toEqual([...ALL_TARGETS].sort());
  expect([...scenariosOf('bailian')].sort()).toEqual(['normal', ...FAULTS].sort());
  for (const target of UNION_TARGETS) {
    expect([...scenariosOf(target)].sort(), target).toEqual([...UNION_SCENARIOS].sort());
  }
});

it.each(ALL_TARGETS)(
  '[规划/02 §6.2 X-Scenario] %s：带 X-Scenario 头的请求按头取场景，每个场景恰好命中一条桩且注入的就是该场景；按场景状态也同样能取到',
  (target: FaultTarget) => {
    const mappings = buildMappings(target);
    expect(serveProblems(mappings, target), target).toEqual([]);
    for (const scenario of SCENARIOS_OF[target]) {
      const hit = answer(mappings, {
        method: 'POST',
        path: SAMPLE_PATH[target],
        scenarioHeader: scenario,
      });
      expect(hit === null || hit === 'ambiguous' ? hit : 'stub', `${target} ${scenario}`).toBe(
        'stub',
      );
      if (hit !== null && hit !== 'ambiguous') {
        expect(scenarioProblems(scenario, hit.response), `${target} ${scenario}`).toEqual([]);
      }
    }
  },
);

it('[规划/02 §6.2 超时] 延迟场景短于在线超时 3 秒仍正常应答，超时场景长于离线超时 10 秒（百炼）', () => {
  const mappings = buildMappings('bailian');
  const delays = (['delay', 'timeout'] as const).map((scenario) => {
    const hit = answer(mappings, {
      method: 'POST',
      path: SAMPLE_PATH.bailian,
      scenarioHeader: scenario,
    });
    return hit === null || hit === 'ambiguous' ? hit : (hit.response.fixedDelayMilliseconds ?? 0);
  });
  expect(delays.map((d) => typeof d)).toEqual(['number', 'number']);
  const [delay, timeout] = delays as [number, number];
  expect({ delayUnder3s: delay > 0 && delay < 3000, timeoutOver10s: timeout > 10000 }).toEqual({
    delayUnder3s: true,
    timeoutOver10s: true,
  });
});

it('[规划/02 §14 千问行] 百炼没带场景头、场景还在初始状态时按 OpenAI 兼容格式正常应答，不延迟、不出错', () => {
  const hit = answer(buildMappings('bailian'), { method: 'POST', path: SAMPLE_PATH.bailian });
  expect(hit === null || hit === 'ambiguous' ? hit : 'stub').toBe('stub');
  if (hit !== null && hit !== 'ambiguous') {
    expect(scenarioProblems('normal', hit.response)).toEqual([]);
  }
});

it.each(UNION_TARGETS)(
  '[AGENTS.md 硬规则 7] %s：没有录制就不伪造平台报文——所有桩都不是 2xx、不带响应体、不转发到真实上游',
  (target: FaultTarget) => {
    const mappings = buildMappings(target);
    expect(mappings.length, target).toBeGreaterThan(0);
    for (const m of mappings) {
      const r = m.response;
      expect(
        {
          success: r.status !== undefined && r.status >= 200 && r.status < 300,
          jsonBody: r.jsonBody !== undefined,
          body: r.body !== undefined && r.body !== '',
          proxy: 'proxyBaseUrl' in r,
        },
        m.name,
      ).toEqual({ success: false, jsonBody: false, body: false, proxy: false });
    }
    const idle = answer(mappings, { method: 'POST', path: SAMPLE_PATH[target] });
    expect(idle, `${target} without X-Scenario in the initial state`).toBeNull();
  },
);

it('[09 README §0.2 硬规则 5] 百炼桩不转发到真实上游，各目标的桩互不串路径，桩名全局唯一', () => {
  const all = ALL_TARGETS.flatMap((target) => buildMappings(target).map((m) => ({ target, m })));
  expect(all.filter(({ m }) => 'proxyBaseUrl' in m.response).map(({ m }) => m.name)).toEqual([]);
  const crossing = all.flatMap(({ target, m }) =>
    ALL_TARGETS.filter(
      (other) =>
        other !== target &&
        new RegExp(`^(?:${m.request.urlPathPattern})$`).test(SAMPLE_PATH[other]),
    ).map((other) => `${m.name} (${target}) matches ${other}`),
  );
  expect(crossing).toEqual([]);
  const names = all.map(({ m }) => m.name);
  expect(names.length).toBeGreaterThan(0);
  expect(new Set(names).size).toBe(names.length);
});
