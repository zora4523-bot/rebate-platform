import { formatYuan, formatYuanAdmin, yuanStrToFen } from '@couli/money';
import { createPropStats, propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';

const fenArbitrary = fc.oneof(
  fc.bigInt({ min: -9223372036854775808n, max: 9223372036854775807n }),
  fc.constantFrom(
    0n,
    1n,
    -1n,
    10n,
    -10n,
    100n,
    9007199254740993n,
    -9223372036854775808n,
    9223372036854775807n,
  ),
);

it.each([
  { name: 'App', format: formatYuan, pattern: /^[+-]?¥(?:0|[1-9][0-9]*)(?:\.[0-9]?[1-9])?$/ },
  {
    name: 'Admin',
    format: formatYuanAdmin,
    pattern: /^[+-]?¥(?:0|[1-9][0-9]{0,2}(?:,[0-9]{3})*)\.[0-9]{2}$/,
  },
])(
  '[AC-F1-06d#12][BR-TEXT-10] $name 在完整 int64 范围逐分无损且格式规范',
  ({ name, format, pattern }) => {
    const params = propParams();
    const stats = createPropStats(`money:display:${name}:round-trip`);
    fc.assert(
      fc.property(fenArbitrary, fc.boolean(), (fen, signed) => {
        stats.hit(fen < 0n ? 'negative' : fen === 0n ? 'zero' : 'positive');
        const text = format(fen, { signed });
        const prefix = fen < 0n ? '-¥' : signed && fen > 0n ? '+¥' : '¥';
        return (
          pattern.test(text) &&
          text.startsWith(prefix) &&
          yuanStrToFen(text.replace(/[¥,+]/g, '')) === fen
        );
      }),
      params,
    );
    const record = stats.flush();
    expect({
      count: Object.values(record.hits).reduce((sum, count) => sum + count, 0),
      discards: record.discards,
    }).toEqual({ count: params.numRuns, discards: 0 });
  },
);
