import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { createMemoryTotpReplayStore } from './totp-replay-memory.ts';

const account = { appId: 'couli', adminId: '019a0000-0000-7000-8000-000000000001' };

it('[AC-F1-06b-REPLAY#1] consumes each (app, admin, step) once and forgets steps outside the window', async () => {
  const clock = new FixedClock(new Date(59_000)); // step 1
  const store = createMemoryTotpReplayStore({ clock });
  expect(await store.consume({ ...account, timeStep: 1n })).toBe(true);
  expect(await store.consume({ ...account, timeStep: 1n })).toBe(false);
  expect(await store.consume({ ...account, appId: 'couli_two', timeStep: 1n })).toBe(true);
  expect(await store.consume({ ...account, timeStep: 2n })).toBe(true);
  clock.advanceMs(60_000); // step 3: step 2 is still inside the window
  expect(await store.consume({ ...account, timeStep: 2n })).toBe(false);
  clock.advanceMs(60_000); // step 5: step 2 can no longer match, so it is dropped
  expect(await store.consume({ ...account, timeStep: 2n })).toBe(true);
});
