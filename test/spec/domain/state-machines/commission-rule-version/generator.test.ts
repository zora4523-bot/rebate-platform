import { expect, it } from 'vitest';
import {
  MACHINES,
  renderStateMachine,
} from '../../../../../packages/domain/scripts/state-machines.ts';
import { generatedExports, readRequired } from '../../../state-machines/order/kit.ts';
import { EVENTS, NAME, SOURCE, STATES, TARGET, transitionFunction } from './kit.ts';

it('[AC-B2-03j#7] 生成器登记 commission-rule-version 且保留两种订单状态机', () => {
  expect(MACHINES).toContain(NAME);
  expect(MACHINES).toContain('order-platform');
  expect(MACHINES).toContain('order-rebate');
  expect(new Set(MACHINES).size).toBe(MACHINES.length);
});

it('[AC-B2-03j#8] render 的结果稳定、与生成物逐字一致并保留来源标记', () => {
  const yaml = readRequired(SOURCE);
  expect(() => renderStateMachine(yaml)).not.toThrow();
  const actual = renderStateMachine(yaml);
  expect(actual).toBe(readRequired(TARGET));
  expect(renderStateMachine(yaml)).toBe(actual);
  expect(actual).toContain('生成物，勿手改');
  expect(actual).toContain(SOURCE);
  const exports = generatedExports(actual);
  expect(exports['COMMISSION_RULE_VERSION_STATES']).toEqual(STATES);
  expect(exports['COMMISSION_RULE_VERSION_EVENTS']).toEqual(EVENTS);
});

// 只用于检验渲染器是否忠实读取输入，不代表另加业务迁移。
const FIXTURE = `name: commission-rule-version
field: status
states: [draft, published, revoked]
events: [DRAFT_CREATED, PUBLISH, REVOKE]
transitions:
  - id: V1
    from: [null]
    event: DRAFT_CREATED
    to: draft
    guard: '—'
    test_id: AC-B2-03j-fixture
  - id: V2
    from: [draft]
    event: PUBLISH
    to: published
    guard: 'throw new Error("guard must remain text")'
    test_id: AC-B2-03j-fixture
`;

it('[AC-B2-03j#9] render 支持数据库小写状态且事件仍为大写，守卫只保留文字', () => {
  expect(() => renderStateMachine(FIXTURE)).not.toThrow();
  const exports = generatedExports(renderStateMachine(FIXTURE));
  expect(exports['COMMISSION_RULE_VERSION_STATES']).toEqual(STATES);
  expect(exports['COMMISSION_RULE_VERSION_EVENTS']).toEqual(EVENTS);
  expect(exports['COMMISSION_RULE_VERSION_TRANSITIONS']).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: 'PUBLISH',
        guard: 'throw new Error("guard must remain text")',
      }),
    ]),
  );
  expect(transitionFunction(exports)('draft', 'PUBLISH')).toEqual({
    ok: true,
    to: 'published',
    id: 'V2',
    noop: false,
  });
});

it('[AC-B2-03j#10] render 随 YAML 目标变化，不硬编码规则版本迁移', () => {
  expect(() => renderStateMachine(FIXTURE)).not.toThrow();
  const first = renderStateMachine(FIXTURE);
  const changed = renderStateMachine(FIXTURE.replace('to: published', 'to: revoked'));
  expect(changed).not.toBe(first);
  expect(transitionFunction(generatedExports(changed))('draft', 'PUBLISH')).toEqual({
    ok: true,
    to: 'revoked',
    id: 'V2',
    noop: false,
  });
});
