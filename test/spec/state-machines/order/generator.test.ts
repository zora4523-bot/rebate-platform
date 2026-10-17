import { expect, it } from 'vitest';
import { renderStateMachine } from '../../../../packages/domain/scripts/state-machines.ts';
import { generatedExports, generatedText, yamlText } from './kit.ts';

it.each(['order-platform', 'order-rebate'] as const)(
  '[AC-CT-04a-GEN#1] %s 纯函数生成结果与入库文本逐字一致且稳定',
  (name) => {
    const yaml = yamlText(name);
    const actual = renderStateMachine(yaml);
    expect(actual).toBe(generatedText(name));
    expect(renderStateMachine(yaml)).toBe(actual);
    expect(actual).toContain('生成物，勿手改');
    expect(actual).toContain(`specs/state-machines/${name}.yaml`);
  },
);

// 合成结构夹具，不是新增业务迁移；用于证明生成器读取输入而非返回固定文件。
const FIXTURE = `name: order-rebate
field: rebate_status
states: [UNATTRIBUTED, ESTIMATED, WAITING]
events: [IMPORT_UNATTRIBUTED, CLAIM_APPROVED]
transitions:
  - id: R1
    from: [null]
    event: IMPORT_UNATTRIBUTED
    to: UNATTRIBUTED
    guard: '—'
    test_id: SM-REB-R1
  - id: R3
    from: [UNATTRIBUTED]
    event: CLAIM_APPROVED
    to: ESTIMATED
    guard: 'orders.locked=false'
    test_id: SM-REB-R3
`;

it('[AC-CT-04a-GEN#2] 输入目标变化会改变生成代码及 transition 的结果', () => {
  const first = renderStateMachine(FIXTURE);
  const changed = renderStateMachine(FIXTURE.replace('to: ESTIMATED', 'to: WAITING'));
  expect(first).not.toBe(changed);
  for (const [source, target] of [
    [first, 'ESTIMATED'],
    [changed, 'WAITING'],
  ]) {
    expect(source).toEqual(expect.any(String));
    const exports = generatedExports(source as string);
    expect(exports['ORDER_REBATE_STATES']).toEqual(['UNATTRIBUTED', 'ESTIMATED', 'WAITING']);
    expect(exports['ORDER_REBATE_EVENTS']).toEqual(['IMPORT_UNATTRIBUTED', 'CLAIM_APPROVED']);
    expect(exports['transitionOrderRebate']).toEqual(expect.any(Function));
    const transition = exports['transitionOrderRebate'] as (from: string, event: string) => unknown;
    expect(transition('UNATTRIBUTED', 'CLAIM_APPROVED')).toEqual({
      ok: true,
      to: target,
      id: 'R3',
      noop: false,
    });
  }
});

it('[AC-CT-04a-GEN#3] 守卫只保留为文字，生成代码不求值或执行它', () => {
  const guard = 'globalThis.guardExecuted = true; orders.locked=false';
  const source = renderStateMachine(FIXTURE.replace('orders.locked=false', guard));
  const exports = generatedExports(source);
  expect(exports['ORDER_REBATE_TRANSITIONS']).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'R3', guard })]),
  );
  expect(exports['transitionOrderRebate']).toEqual(expect.any(Function));
  const transition = exports['transitionOrderRebate'] as (from: string, event: string) => unknown;
  // 若求值守卫，未定义的 orders 会失败；纯查表必须仍然成功。
  expect(transition('UNATTRIBUTED', 'CLAIM_APPROVED')).toEqual({
    ok: true,
    to: 'ESTIMATED',
    id: 'R3',
    noop: false,
  });
});

it.each(['order-platform', 'order-rebate'] as const)(
  '[AC-CT-04a-GEN#4] %s 生成物无导入、无 enum/namespace 且可独立运行',
  (name) => {
    const source = renderStateMachine(yamlText(name));
    const exports = generatedExports(source);
    const prefix = name === 'order-platform' ? 'ORDER_PLATFORM' : 'ORDER_REBATE';
    expect(exports[`${prefix}_STATES`]).toEqual(expect.any(Array));
    expect(exports[`${prefix}_EVENTS`]).toEqual(expect.any(Array));
    expect(exports[`${prefix}_TRANSITIONS`]).toEqual(expect.any(Array));
  },
);
