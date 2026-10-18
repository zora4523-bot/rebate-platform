import { expect, it } from 'vitest';
import {
  MACHINES,
  renderStateMachine,
} from '../../../../../packages/domain/scripts/state-machines.ts';
import { generatedExports, readRequired } from '../../../state-machines/order/kit.ts';
import { EVENTS, LEGAL, machine, NAME, SOURCE, STATES, TARGET, transitionFunction } from './kit.ts';

it('[AC-F1-02u#8] 自动发现 article-version，并保留已登记的状态机', () => {
  expect(MACHINES).toContain(NAME);
  for (const name of [
    'claim',
    'claim-item',
    'commission-rule-version',
    'order-platform',
    'order-rebate',
    'page-version',
    'withdrawal',
  ]) {
    expect(MACHINES).toContain(name);
  }
  expect(new Set(MACHINES).size).toBe(MACHINES.length);
});

it('[AC-F1-02u#9] render 稳定且与生成物逐字一致，完整保留三行迁移', () => {
  const yaml = readRequired(SOURCE);
  const actual = renderStateMachine(yaml);
  expect(actual).toBe(readRequired(TARGET));
  expect(renderStateMachine(yaml)).toBe(actual);
  expect(actual).toContain('生成物，勿手改');
  expect(actual).toContain(SOURCE);
  const exports = generatedExports(actual);
  expect(exports['ARTICLE_VERSION_STATES']).toEqual(expect.arrayContaining([...STATES]));
  expect(exports['ARTICLE_VERSION_STATES']).toHaveLength(STATES.length);
  expect(exports['ARTICLE_VERSION_EVENTS']).toEqual(expect.arrayContaining([...EVENTS]));
  expect(exports['ARTICLE_VERSION_EVENTS']).toHaveLength(EVENTS.length);
  expect(exports['ARTICLE_VERSION_TRANSITIONS']).toEqual(machine().transitions);
  const transition = transitionFunction(exports);
  for (const row of LEGAL) {
    expect(transition(row.from, row.event)).toEqual({
      ok: true,
      to: row.to,
      id: row.id,
      noop: false,
    });
  }
});

it('[AC-F1-02u#10] 守卫只保留文字，不由生成的 transition 执行', () => {
  const yaml = readRequired(SOURCE);
  const guard = 'throw new Error("guard must remain text")';
  // 权限、最新版本、CAS、published_at 和整篇下线事务由服务层 F1-02w 验证。
  const changed = yaml.replace(/^(\s*guard:)\s*[^\r\n]+/gm, `$1 '${guard}'`);
  expect(changed).not.toBe(yaml);
  const exports = generatedExports(renderStateMachine(changed));
  expect(exports['ARTICLE_VERSION_TRANSITIONS']).toHaveLength(3);
  expect(exports['ARTICLE_VERSION_TRANSITIONS']).toEqual(
    expect.arrayContaining(LEGAL.map((row) => expect.objectContaining({ id: row.id, guard }))),
  );
  const transition = transitionFunction(exports);
  for (const row of LEGAL) {
    expect(transition(row.from, row.event)).toEqual({
      ok: true,
      to: row.to,
      id: row.id,
      noop: false,
    });
  }
});
