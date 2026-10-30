// B2-04zf: settle.run_done is a registered event name (platform/events EVENT_NAMES; the bus refuses
// any other name). Two segments like every 02 §11 name, registered once, right after
// settle.batch_done (so the names 02 §11 keeps in order around it stay where they are).
import { expect, it } from 'vitest';
import { EVENT_NAMES } from '../../../../apps/api/src/modules/platform/events/index.ts';

const RUN_DONE = 'settle.run_done';

it('[AC-B2-04zf#10] EVENT_NAMES 登记 settle.run_done 一次，紧接 settle.batch_done 之后；名单仍冻结', () => {
  const names = [...EVENT_NAMES];
  expect(names.filter((name) => name === RUN_DONE)).toHaveLength(1);
  const at = names.indexOf(RUN_DONE);
  expect(at).toBeGreaterThan(0);
  expect(names[at - 1]).toBe('settle.batch_done');
  expect(Object.isFrozen(EVENT_NAMES)).toBe(true);
});
