// B2-05d / BR-WDR-07 细则: out_biz_no = 'W' + 20 characters of [A-Z0-9], ASCII only, at most 32,
// carrying nothing of the user. The random source is injected (node:crypto randomBytes in
// production, a deterministic stream in tests): no clock, no global state, so the same byte
// stream gives the same number. Each byte maps to one character (value mod 36); the slight
// non-uniformity is irrelevant for uniqueness, which the (app_id, out_biz_no) unique key enforces
// (the caller regenerates on a collision).
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const LENGTH = 20;

export function generateOutBizNo(randomBytes: (size: number) => Uint8Array): string {
  const bytes = randomBytes(LENGTH);
  if (bytes.length < LENGTH) throw new RangeError('out_biz_no: too few random bytes');
  let text = 'W';
  for (let i = 0; i < LENGTH; i += 1) text += ALPHABET[bytes[i]! % ALPHABET.length];
  return text;
}
