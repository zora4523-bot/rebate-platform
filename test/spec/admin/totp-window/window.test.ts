import { expect, it, vi } from 'vitest';
import {
  createTotpVerifier,
  type TotpReplayStore,
} from '../../../../apps/api/src/modules/admin/domain/totp.ts';
import {
  ACCOUNT,
  COLLISION_CODE,
  COLLISION_INSTANTS,
  COLLISION_STEP,
  COLLISION_STEP_START,
  PREVIOUS_STEP,
  claim,
  context,
  expectCollision,
  fixture,
} from './kit.ts';

// 编排裁定 D10-238 (BR-ID-34: admin login and dynamic-code step-up use TOTP). The collision
// constants are re-checked with an independent HMAC at the start of every test (kit.ts).

it.each(COLLISION_INSTANTS)(
  '[AC-B1-34l#1] previous matched step already used: the same code is accepted for step N (%s)',
  async (_label, epochMs) => {
    expectCollision();
    const f = await fixture(epochMs, [claim(PREVIOUS_STEP)]);
    const verifier = createTotpVerifier({ ...f, digits: 6 });
    const request = { ...ACCOUNT, secretCipher: f.secretCipher, code: COLLISION_CODE };
    expect(await verifier.verify(request)).toBe(true);
    expect(f.decrypt).toHaveBeenCalledWith(f.secretCipher.toString('utf8'), context(ACCOUNT));
    expect(f.consume.mock.calls).toEqual([[claim(PREVIOUS_STEP)], [claim(COLLISION_STEP)]]);
  },
);

it('[AC-B1-34l#1] a code accepted in step N-1 is accepted once more in step N (login, then step-up)', async () => {
  expectCollision();
  const f = await fixture(COLLISION_STEP_START * 1000 - 1);
  const verifier = createTotpVerifier({ ...f, digits: 6 });
  const request = { ...ACCOUNT, secretCipher: f.secretCipher, code: COLLISION_CODE };
  expect(await verifier.verify(request)).toBe(true);
  expect(f.consume.mock.calls).toEqual([[claim(PREVIOUS_STEP)]]);
  f.clock.advanceMs(1);
  const next = createTotpVerifier({ ...f, digits: 6 });
  expect(await next.verify(request)).toBe(true);
  expect(f.consume.mock.calls).toEqual([
    [claim(PREVIOUS_STEP)],
    [claim(PREVIOUS_STEP)],
    [claim(COLLISION_STEP)],
  ]);
});

it.each(COLLISION_INSTANTS)(
  '[AC-B1-34l#2] both matched steps already used: the code is refused as a replay (%s)',
  async (_label, epochMs) => {
    expectCollision();
    const f = await fixture(epochMs, [claim(PREVIOUS_STEP), claim(COLLISION_STEP)]);
    const verifier = createTotpVerifier({ ...f, digits: 6 });
    const request = { ...ACCOUNT, secretCipher: f.secretCipher, code: COLLISION_CODE };
    expect(await verifier.verify(request)).toBe(false);
    expect(f.consume.mock.calls).toEqual([[claim(PREVIOUS_STEP)], [claim(COLLISION_STEP)]]);
  },
);

it('[AC-B1-34l#2] a colliding code serves at most its two steps: the third use is refused', async () => {
  expectCollision();
  const f = await fixture(COLLISION_STEP_START * 1000 + 10_000);
  const verifier = createTotpVerifier({ ...f, digits: 6 });
  const request = { ...ACCOUNT, secretCipher: f.secretCipher, code: COLLISION_CODE };
  expect(await verifier.verify(request)).toBe(true);
  expect(await verifier.verify(request)).toBe(true);
  expect(await verifier.verify(request)).toBe(false);
  expect(f.consume.mock.calls).toEqual([
    [claim(PREVIOUS_STEP)],
    [claim(PREVIOUS_STEP)],
    [claim(COLLISION_STEP)],
    [claim(PREVIOUS_STEP)],
    [claim(COLLISION_STEP)],
  ]);
});

it.each(COLLISION_INSTANTS)(
  '[AC-B1-34l#3] with nothing used, only the lower matched step is consumed (%s)',
  async (_label, epochMs) => {
    expectCollision();
    const f = await fixture(epochMs);
    const verifier = createTotpVerifier({ ...f, digits: 6 });
    const request = { ...ACCOUNT, secretCipher: f.secretCipher, code: COLLISION_CODE };
    expect(await verifier.verify(request)).toBe(true);
    expect(f.consume).toHaveBeenCalledExactlyOnceWith(claim(PREVIOUS_STEP));
  },
);

it.each<[string, boolean[], boolean, bigint[]]>([
  ['true', [true], true, [PREVIOUS_STEP]],
  ['false, true', [false, true], true, [PREVIOUS_STEP, COLLISION_STEP]],
  ['false, false', [false, false], false, [PREVIOUS_STEP, COLLISION_STEP]],
])(
  '[AC-B1-34l#3] consume answers %s: steps are tried in ascending order, none after the first success',
  async (_label, answers, accepted, steps) => {
    expectCollision();
    const f = await fixture(COLLISION_STEP_START * 1000 + 15_000);
    const consume = vi.fn<TotpReplayStore['consume']>();
    for (const answer of answers) consume.mockResolvedValueOnce(answer);
    consume.mockResolvedValue(true);
    const verifier = createTotpVerifier({ ...f, replay: { consume }, digits: 6 });
    const request = { ...ACCOUNT, secretCipher: f.secretCipher, code: COLLISION_CODE };
    expect(await verifier.verify(request)).toBe(accepted);
    expect(consume.mock.calls).toEqual(steps.map((step) => [claim(step)]));
  },
);

it('[AC-B1-34l#4] consume throwing on the first matched step fails the verification; step N is not claimed', async () => {
  expectCollision();
  const f = await fixture(COLLISION_STEP_START * 1000 + 15_000);
  const failure = new Error('replay store unavailable');
  const consume = vi.fn<TotpReplayStore['consume']>();
  consume.mockRejectedValueOnce(failure);
  consume.mockResolvedValue(true);
  const verifier = createTotpVerifier({ ...f, replay: { consume }, digits: 6 });
  const request = { ...ACCOUNT, secretCipher: f.secretCipher, code: COLLISION_CODE };
  await expect(verifier.verify(request)).rejects.toBe(failure);
  expect(consume).toHaveBeenCalledExactlyOnceWith(claim(PREVIOUS_STEP));
});

it('[AC-B1-34l#4] consume throwing on step N after N-1 was refused fails the verification', async () => {
  expectCollision();
  const f = await fixture(COLLISION_STEP_START * 1000 + 15_000);
  const failure = new Error('replay store unavailable');
  const consume = vi.fn<TotpReplayStore['consume']>();
  consume.mockResolvedValueOnce(false);
  consume.mockRejectedValueOnce(failure);
  consume.mockResolvedValue(true);
  const verifier = createTotpVerifier({ ...f, replay: { consume }, digits: 6 });
  const request = { ...ACCOUNT, secretCipher: f.secretCipher, code: COLLISION_CODE };
  await expect(verifier.verify(request)).rejects.toBe(failure);
  expect(consume.mock.calls).toEqual([[claim(PREVIOUS_STEP)], [claim(COLLISION_STEP)]]);
});
