// Unit checks for display.ts internals; the BR-TEXT-10 vectors themselves live in test/spec.
import { expect, it } from 'vitest';
import { formatYuan, formatYuanAdmin, formatYuanRange, InvalidAmount } from './index.ts';
import { InvalidAmount as InvalidAmountFromModule } from './errors.ts';

it('[AC-F1-06d#unit-1] admin grouping places commas at every digit-count boundary', () => {
  expect(
    [0n, 100n, 99900n, 100000n, 9999900n, 10000000n, 99999900n, 100000000n].map((fen) =>
      formatYuanAdmin(fen),
    ),
  ).toEqual([
    '¥0.00',
    '¥1.00',
    '¥999.00',
    '¥1,000.00',
    '¥99,999.00',
    '¥100,000.00',
    '¥999,999.00',
    '¥1,000,000.00',
  ]);
});

it('[AC-F1-06d#unit-2] only signed === true adds "+"; truthy non-boolean values do not', () => {
  const loose = { signed: 1 } as unknown as { signed?: boolean };
  const outputs = [
    formatYuan(5n, loose),
    formatYuanAdmin(5n, loose),
    formatYuan(5n, { signed: true }),
  ];
  expect(outputs).toEqual(['¥0.05', '¥0.05', '+¥0.05']);
});

it('[AC-F1-06d#unit-3] range uses U+2013 with no spaces and the re-exported error class', () => {
  const text = formatYuanRange(1n, 10n);
  expect([text, text?.includes('– '), InvalidAmount === InvalidAmountFromModule]).toEqual([
    '¥0.01–¥0.1',
    false,
    true,
  ]);
});
