// B1-01zu: addendum A describes toJSON replacement; L retains Error-specific treatment
// under err. Do not prescribe an unspecified response/config/request output shape or turn
// every Error property into free text. The task requires no plaintext from response.data.
// This is a synthetic Error fixture, not a recorded or simulated platform response.
import { expect, it } from 'vitest';
import { KEPT, SAMPLES, capture, parseStrict } from './kit.ts';

class ResponseError extends Error {
  readonly code = 502;
  readonly response = {
    data: {
      contact: SAMPLES.phone,
      recipients: [{ value: SAMPLES.contactPhone }, SAMPLES.alipayEmail],
    },
  };

  toJSON(): Record<string, unknown> {
    return { message: this.message, code: this.code };
  }
}

it.each(['field', 'nested', 'binding'] as const)(
  '[AC-B1-01zu#2] 带 toJSON 的 Error 子类经 %s 写日志不泄露 response.data 中的手机号',
  (channel) => {
    const failure = new ResponseError('request failed');
    failure.stack = 'ResponseError: request failed';
    const { logger, lines } = capture();
    const fields = {
      order_id: KEPT.order_id,
      ...(channel === 'nested' ? { context: { err: failure } } : { err: failure }),
    };

    if (channel === 'binding') logger.child(fields).error('request rejected');
    else logger.error(fields, 'request rejected');

    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    const record = parseStrict(line) as Record<string, unknown>;
    expect(record).toMatchObject({
      entry: 'spec',
      env: 'test',
      level: 50,
      order_id: KEPT.order_id,
      msg: 'request rejected',
      ...(channel === 'nested'
        ? { context: { err: { message: 'request failed' } } }
        : { err: { message: 'request failed' } }),
    });
    // Inspect raw and decoded JSON so escaped digits cannot hide a leak from the assertion.
    for (const secret of [SAMPLES.phone, SAMPLES.contactPhone, SAMPLES.alipayEmail]) {
      expect(line).not.toContain(secret);
      expect(JSON.stringify(record)).not.toContain(secret);
    }
    expect(failure.response.data).toEqual({
      contact: SAMPLES.phone,
      recipients: [{ value: SAMPLES.contactPhone }, SAMPLES.alipayEmail],
    });
  },
);
