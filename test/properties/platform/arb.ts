// Generators and coverage check shared by the platform/crypto property tests (规划/11 §4.2).
// Plaintexts cover the shapes BR-ID-33 names (digit strings: phone, id and card numbers), text
// with multi-byte characters, and long values; each bucket must get at least 1% of the runs.
import { propRuns } from '@couli/testing';
import type { PropStatsRecord } from '@couli/testing';
import fc from 'fast-check';
import type { FieldCrypto } from '../../../apps/api/src/modules/platform/crypto/index.ts';
import { openFieldCrypto } from '../../../apps/api/src/modules/platform/crypto/index.ts';
import { FakeKms, knownKeyring } from '../../spec/platform/crypto/kit.ts';

/** Every character a context may contain: printable ASCII 0x21..0x7e. */
export const CONTEXT_CHARS: readonly string[] = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) =>
  String.fromCharCode(0x21 + i),
);

const DIGITS: readonly string[] = [...'0123456789'];

const contextChar = fc.constantFrom(...CONTEXT_CHARS);

/** A valid context of at most `maxLength` characters; real column names are weighted in. */
export function contextUpTo(maxLength: number): fc.Arbitrary<string> {
  return fc.oneof(
    {
      arbitrary: fc.constantFrom(
        'users.phone',
        'realname.id_no',
        'payout_accounts.alipay_logon_id',
        'payout_accounts.bank_card_no',
      ),
      weight: 3,
    },
    { arbitrary: fc.string({ unit: contextChar, minLength: 1, maxLength }), weight: 1 },
  );
}

/** One more valid context character, to derive a context that differs from another one. */
export const extraContextChar: fc.Arbitrary<string> = contextChar;

/**
 * A non-empty, well-formed plaintext. Lengths are kept short on purpose: the properties run
 * 100 000 times per pull request and 1 000 000 times before a merge (规划/11 §4.2), and the
 * rule tests in test/spec cover long values.
 */
export const plaintext: fc.Arbitrary<string> = fc.oneof(
  {
    arbitrary: fc.string({ unit: fc.constantFrom(...DIGITS), minLength: 1, maxLength: 19 }),
    weight: 4,
  },
  { arbitrary: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 12 }), weight: 3 },
  { arbitrary: fc.string({ unit: 'binary', minLength: 1, maxLength: 12 }), weight: 2 },
  { arbitrary: fc.string({ unit: 'grapheme-ascii', minLength: 64, maxLength: 96 }), weight: 1 },
);

/** A non-empty suffix: `value + suffix` is always a different value. */
export const suffix: fc.Arbitrary<string> = fc.string({
  unit: 'grapheme',
  minLength: 1,
  maxLength: 8,
});

export function bucketOf(text: string): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes >= 64) return 'long';
  if (bytes !== text.length) return 'multibyte';
  return /^[0-9]+$/.test(text) ? 'digits' : 'ascii';
}

/** Which required buckets got at least 1% of the runs (not meaningful below 1000 runs). */
export function coverage(record: PropStatsRecord): Record<string, boolean> {
  const runs = propRuns();
  const floor = runs / 100;
  const enough = (bucket: string): boolean => runs < 1000 || (record.hits[bucket] ?? 0) >= floor;
  return {
    digits: enough('digits'),
    multibyte: enough('multibyte'),
    long: enough('long'),
    no_discards: record.discards === 0,
  };
}

export const FULL_COVERAGE: Record<string, boolean> = {
  digits: true,
  multibyte: true,
  long: true,
  no_discards: true,
};

/**
 * Time limit of one property: the default 5 s of the unit configuration is too tight for
 * 100 000 runs of an AES round trip on a small CI runner, and the long run (1 000 000) needs
 * more. 0.3 ms per run is about ten times what a run takes on a developer machine.
 */
export const PROPERTY_TIMEOUT_MS: number = Math.max(30_000, Math.ceil(propRuns() * 0.3));

/** Data key versions of the keyring the properties run on; version 2 is current. */
export const CURRENT_VERSION = 2;

export interface OpenedCrypto {
  readonly crypto: FieldCrypto;
  /** Plain data key of a version (known to the test, see kit.ts). */
  dataKey(version: number): Buffer;
  readonly blindKey: Buffer;
}

/** A FieldCrypto over a keyring whose plain keys the test knows. */
export async function openKnown(): Promise<OpenedCrypto> {
  const kms = new FakeKms();
  const known = knownKeyring(kms, [1, CURRENT_VERSION], CURRENT_VERSION);
  return {
    crypto: await openFieldCrypto(known.doc, kms),
    dataKey: known.dataKey,
    blindKey: known.blindKey,
  };
}
