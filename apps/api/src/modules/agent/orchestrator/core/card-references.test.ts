import { expect, it } from 'vitest';
import type { RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import { cardReference, openCardCall } from './card-references.ts';
import { orchestratorLimitsDefaults } from './factories.ts';
import { RunOutput } from './output.ts';

function callContext(placeholders: Readonly<Record<string, string>>) {
  return {
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    placeholders,
  };
}

function notice(): UnnumberedCard {
  return {
    type: 'notice',
    schema_version: 1,
    data: { level: 'info', text_key: 'synthetic.notice', actions: [] },
    fallback_text: 'synthetic',
  };
}

it('[B3-05i] a reference is bound to its call’s own placeholders object and closes with the call', () => {
  const tableA = Object.freeze({ '<num_1>': '987654321012' });
  const tableB = Object.freeze({ '<num_1>': '987654321012' });
  const a = openCardCall('synthetic:call/a', tableA);
  openCardCall('synthetic:call/a', tableB);
  const ref = cardReference(callContext(tableA), 0);
  expect(ref).toMatch(/^@card-ref:[0-9a-f]{32}:synthetic%3Acall%2Fa:0$/u);
  expect(cardReference(callContext(tableA), 0)).toBe(ref);
  // Same model call id in another call: another nonce, never the same reference.
  expect(cardReference(callContext(tableB), 0)).not.toBe(ref);
  // A copy of the table (or any other object) is not a running call's context.
  expect(() => cardReference(callContext({ ...tableA }), 0)).toThrow(/not the context/u);
  expect(() => cardReference(callContext(tableA), -1)).toThrow(RangeError);
  expect(() => cardReference(callContext(tableA), 1.5)).toThrow(RangeError);
  expect(() => openCardCall('synthetic-again', tableA)).toThrow(/already bound/u);
  a.close();
  expect(() => cardReference(callContext(tableA), 1)).toThrow(/settled/u);
});

it('[B3-05i][BR-AI-05] only whole values issued by this call resolve; splices, keys and other calls stay', () => {
  const table = Object.freeze({});
  const otherTable = Object.freeze({});
  const refs = openCardCall('synthetic-call', table);
  openCardCall('synthetic-other', otherTable);
  const [r0, r1, r2] = [0, 1, 2].map((index) => cardReference(callContext(table), index));
  const foreign = cardReference(callContext(otherTable), 0);
  refs.delivered('c7');
  refs.delivered(null);
  // r2 addresses a card the outcome did not have: removed like an undelivered one.
  const view = {
    keep: r0,
    drop: r1,
    beyond: r2,
    spliced: `see ${r0!}`,
    [r0!]: 'as key',
    foreign,
    list: [r1, r0, { drop: r2, n: 1 }, [r1]],
    when: { toJSON: () => r0 },
    gone: undefined,
  };
  const before = JSON.stringify(view);
  expect(refs.view(view)).toEqual({
    keep: 'c7',
    spliced: `see ${r0!}`,
    [r0!]: 'as key',
    foreign,
    list: ['c7', { n: 1 }, []],
    when: 'c7',
  });
  expect(JSON.stringify(view)).toBe(before);
  expect(refs.view(r0)).toBe('c7');
  expect(refs.view(r1)).toBeNull();
  expect(refs.view({ ['__proto__']: r0 })).toEqual(JSON.parse('{"__proto__":"c7"}'));
});

it('[B3-05i] without issued references views and trace records come back unchanged', () => {
  const refs = openCardCall('synthetic-call', Object.freeze({}));
  const view = { card_id: 'c3', missing: undefined };
  expect(refs.view(view)).toBe(view);
  const sources = [{ card_id: 'c3', fields: { source: 'synthetic' } }];
  const out = refs.records(sources, ['card_id']);
  expect(out).toEqual(sources);
  expect(out[0]).toBe(sources[0]);
});

it('[B3-05i][BR-AI-06] trace records naming an undelivered card are left out, delivered ones get the id', () => {
  const table = Object.freeze({});
  const refs = openCardCall('synthetic-call', table);
  const [r0, r1] = [0, 1].map((index) => cardReference(callContext(table), index));
  refs.delivered('c12');
  expect(
    refs.records(
      [
        { card_id: r0!, fields: { source: 'synthetic', other: r1!, again: r0! } },
        { card_id: r1!, fields: { source: 'synthetic' } },
        { card_id: 'c2', fields: {} },
      ],
      ['card_id'],
    ),
  ).toEqual([
    { card_id: 'c12', fields: { source: 'synthetic', again: 'c12' } },
    { card_id: 'c2', fields: {} },
  ]);
  expect(
    refs.records(
      [
        { link_id: 'synthetic-link-a', product_key: r1!, ok: true },
        { link_id: r0!, product_key: 'jd:100012345', ok: true },
      ],
      ['link_id', 'product_key'],
    ),
  ).toEqual([{ link_id: 'c12', product_key: 'jd:100012345', ok: true }]);
});

it('[B3-05i] RunOutput.deliver takes the run context receipt only when it is a session card id', async () => {
  const receipts: unknown[] = ['c41', undefined, 'c0', 'c1 ', 7];
  const ctx: RunContext = {
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    cardsDelivered: 0,
    text: () => undefined,
    toolStatus: () => undefined,
    // Receipt shapes are what is under test, hence the cast through unknown.
    card: (async (_card: UnnumberedCard, delivered?: (cardId: unknown) => void) => {
      const receipt = receipts.shift();
      if (receipt !== undefined) delivered?.(receipt);
    }) as unknown as RunContext['card'],
    suggestions: () => undefined,
  };
  const out = new RunOutput(ctx, orchestratorLimitsDefaults());
  const results = [];
  for (let i = 0; i < 5; i += 1) results.push(await out.deliver(notice()));
  expect(results).toEqual([
    { written: true, cardId: 'c41' },
    { written: true, cardId: null },
    { written: true, cardId: null },
    { written: true, cardId: null },
    { written: true, cardId: null },
  ]);
});
