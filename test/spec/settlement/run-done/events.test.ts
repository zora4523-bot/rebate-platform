// B2-04zf: settle.run_done is a registered event name (platform/events EVENT_NAMES; the bus refuses
// any other name). Two segments like every 02 §11 name, registered once, at its place in the 02 §11
// list kept by the event suite (PLAN_02_EVENTS, D10-477): the names around it keep their order.
import { expect, it } from 'vitest';
import { EVENT_NAMES } from '../../../../apps/api/src/modules/platform/events/index.ts';
import { PLAN_02_EVENTS } from '../../platform/events/kit.ts';

const RUN_DONE = 'settle.run_done';

it('[AC-B2-04zf#14] EVENT_NAMES 登记 settle.run_done 恰好一次，与 02 §11 清单（PLAN_02_EVENTS）同序；名单仍冻结', () => {
  const plan: readonly string[] = PLAN_02_EVENTS;
  const names = [...EVENT_NAMES];
  expect(plan).toContain(RUN_DONE);
  expect(names.filter((name) => name === RUN_DONE)).toHaveLength(1);
  expect(names.filter((name) => plan.includes(name))).toEqual(
    plan.filter((name) => names.includes(name)),
  );
  expect(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(RUN_DONE)).toBe(true);
  expect(Object.isFrozen(EVENT_NAMES)).toBe(true);
});
