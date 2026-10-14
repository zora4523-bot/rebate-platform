// B1-01zu: addenda A/B in log-redaction-review.test.ts. The task permits either intrinsic
// unboxing or applying conversion rules again to an overridden valueOf's result.
import { expect, it } from 'vitest';
import { REDACTED, SAMPLES, capture, expectLine, parseStrict } from './kit.ts';

it.each([
  { kind: 'String', primitive: 'boxed-safe', written: 'boxed-safe' },
  { kind: 'Number', primitive: 42, written: 42 },
  { kind: 'Boolean', primitive: true, written: true },
  { kind: 'BigInt', primitive: 42n, written: 42 },
])(
  '[AC-B1-01zu#1] $kind 的 valueOf 返回带 toJSON 的对象时不写出隐藏原文',
  ({ primitive, written }) => {
    const terminal = { phone: SAMPLES.phone, message: `contact ${SAMPLES.contactPhone}` };
    const replacement = {
      hidden: { contact: SAMPLES.phone, recipient: SAMPLES.alipayEmail },
      toJSON: () => ({ toJSON: () => terminal }),
    };
    const boxed = Object(primitive) as object;
    Object.defineProperty(boxed, 'valueOf', { value: () => replacement });
    const { logger, lines } = capture();

    logger.info({ payload: boxed }, 'field');
    logger.info({ payload: { list: [boxed] } }, 'nested');
    logger.child({ payload: boxed }).info('binding');
    const child = logger.child({});
    child.setBindings({ payload: boxed });
    child.info('setBindings');

    expect(lines).toHaveLength(4);
    const safeReplacement = { phone: REDACTED, message: `contact ${REDACTED}` };
    for (const [index, msg] of ['field', 'nested', 'binding', 'setBindings'].entries()) {
      const line = lines[index] ?? '';
      expect(line).not.toContain(SAMPLES.phone);
      expect(line).not.toContain(SAMPLES.alipayEmail);
      const record = parseStrict(line) as Record<string, unknown>;
      const allowed =
        index === 1
          ? [{ list: [written] }, { list: [safeReplacement] }]
          : [written, safeReplacement];
      // A finite set of hand-built outputs: dropping the value or writing a placeholder fails.
      expect(allowed).toContainEqual(record['payload']);
      expectLine(line, { level: 30, payload: record['payload'], msg });
    }
    expect(replacement.hidden).toEqual({
      contact: SAMPLES.phone,
      recipient: SAMPLES.alipayEmail,
    });
    expect(terminal).toEqual({ phone: SAMPLES.phone, message: `contact ${SAMPLES.contactPhone}` });
  },
);
