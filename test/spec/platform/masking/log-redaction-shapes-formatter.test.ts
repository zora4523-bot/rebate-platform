// B1-01zu: retain Error code types through caller formatters (addenda I/L), including
// inherited formatters. Plain err records still follow L's free-text rule.
import { expect, it } from 'vitest';
import { KEPT, REDACTED, SAMPLES, capture, expectLine } from './kit.ts';

it.each(['child', 'grandchild'] as const)(
  '[AC-B1-01zu#3] %s 的自定义 formatter 重建 err 后保留数字 code',
  (generation) => {
    const { logger, lines } = capture();
    const failure = Object.assign(new Error(`request ${SAMPLES.phone}`), { code: 503 });
    failure.stack = `Error: request ${SAMPLES.phone}`;
    let formatterCalls = 0;
    const child = logger.child(
      {},
      {
        formatters: {
          log(record) {
            formatterCalls += 1;
            const fields = record as Record<string, unknown>;
            // Rebuild the actual incoming Error copy, rather than inventing an unrelated err.
            return { ...fields, err: { ...(fields['err'] as object) } };
          },
        },
      },
    );
    const target = generation === 'child' ? child : child.child({});

    target.error({ order_id: KEPT.order_id, err: failure }, 'formatted');
    // A lookalike that did not originate from Error must not gain Error privileges (L).
    logger.error({ err: { type: 'Error', message: 'plain', code: 503 } }, 'plain');

    expect(formatterCalls).toBe(1);
    expect(lines).toHaveLength(2);
    expectLine(lines[0], {
      level: 50,
      order_id: KEPT.order_id,
      err: {
        type: 'Error',
        message: `request ${REDACTED}`,
        stack: `Error: request ${REDACTED}`,
        code: 503,
      },
      msg: 'formatted',
    });
    expectLine(lines[1], {
      level: 50,
      err: { type: 'Error', message: 'plain', code: '503' },
      msg: 'plain',
    });
    expect(failure.code).toBe(503);
    expect(failure.message).toBe(`request ${SAMPLES.phone}`);
  },
);
