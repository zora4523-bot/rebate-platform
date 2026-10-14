// B1-01zz: formatter mutations must keep the Error scalar safety net; replacing an Error
// copy must retain its numeric fields. Controls share the failing cases so each case is red.
import { expect, it } from 'vitest';
import { REDACTED, capture, expectLine, snapshotOf } from './kit.ts';

// Deliberately synthetic, but still matches the documented mainland-phone pattern.
const syntheticPhone = '13900000000';

it.each([
  { result: 'spread', kind: 'string', detail: syntheticPhone },
  { result: 'same', kind: 'string', detail: syntheticPhone },
  { result: 'spread', kind: 'number', detail: Number(syntheticPhone) },
  { result: 'same', kind: 'number', detail: Number(syntheticPhone) },
] as const)(
  '[AC-B1-01zz#1] formatter 改写 Error 自有字段后 return $result：$kind 手机号仍脱敏',
  ({ result, detail }) => {
    const { logger, lines } = capture();
    const failure = Object.assign(new Error('boom'), { code: 503, detail: 'ok' });
    failure.stack = 'Error: boom';
    const before = snapshotOf(failure);
    let formatterCalls = 0;
    const child = logger.child(
      {},
      {
        formatters: {
          log(record) {
            formatterCalls += 1;
            const fields = record as Record<string, unknown>;
            const errorCopy = fields['err'] as Record<string, unknown>;
            errorCopy['detail'] = detail;
            return result === 'spread' ? { ...fields } : fields;
          },
        },
      },
    );

    child.error({ err: failure }, 'mutated');

    expect(formatterCalls).toBe(1);
    expect(lines).toHaveLength(1);
    expect(snapshotOf(failure)).toStrictEqual(before);
    expect(lines[0]).not.toContain(syntheticPhone);
    expectLine(lines[0], {
      level: 50,
      err: { type: 'Error', message: 'boom', stack: 'Error: boom', code: 503, detail: REDACTED },
      msg: 'mutated',
    });
  },
);

it.each(['child', 'grandchild'] as const)(
  '[AC-B1-01zz#2] %s formatter 原地替换 Error 副本保留数字，仿冒 err 仍按自由文本处理',
  (generation) => {
    const { logger, lines } = capture();
    const failure = Object.assign(new Error('boom'), { code: 503, detail: 'ok' });
    failure.stack = 'Error: boom';
    const before = snapshotOf(failure);
    const lookalike = {
      type: 'Error',
      message: 'boom',
      stack: 'Error: boom',
      code: 503,
      detail: 'ok',
    };
    const plainBefore = snapshotOf(lookalike);
    let returnCopy = false;
    let formatterCalls = 0;
    const child = logger.child(
      {},
      {
        formatters: {
          log(record) {
            formatterCalls += 1;
            const fields = record as Record<string, unknown>;
            // B2 leaves the incoming record intact; B replaces err on that same record.
            if (returnCopy) return { ...fields, err: { ...(fields['err'] as object) } };
            fields['err'] = { ...(fields['err'] as object) };
            return fields;
          },
        },
      },
    );
    const target = generation === 'child' ? child : child.child({});

    target.error({ err: failure }, 'replaced');
    target.error({ err: lookalike }, 'plain-in-place');
    returnCopy = true;
    target.error({ err: failure }, 'rebuilt');
    target.error({ err: lookalike }, 'plain-rebuilt');

    expect(formatterCalls).toBe(4);
    expect(lines).toHaveLength(4);
    expect(snapshotOf(failure)).toStrictEqual(before);
    expect(snapshotOf(lookalike)).toStrictEqual(plainBefore);
    // Check the unchanged controls before the assertion that fails on the current implementation.
    expectLine(lines[1], {
      level: 50,
      err: { ...lookalike, code: '503' },
      msg: 'plain-in-place',
    });
    expectLine(lines[2], {
      level: 50,
      err: { type: 'Error', message: 'boom', stack: 'Error: boom', code: 503, detail: 'ok' },
      msg: 'rebuilt',
    });
    expectLine(lines[3], {
      level: 50,
      err: { ...lookalike, code: '503' },
      msg: 'plain-rebuilt',
    });
    expectLine(lines[0], {
      level: 50,
      err: { type: 'Error', message: 'boom', stack: 'Error: boom', code: 503, detail: 'ok' },
      msg: 'replaced',
    });
  },
);
