import { describe, expect, it } from 'vitest';
import {
  chinaIso,
  decodeWithdrawalCursor,
  encodeWithdrawalCursor,
  WithdrawalReadError,
} from './withdrawal-reads.ts';

describe('withdrawal reads: cursor and +08:00 instants', () => {
  it('encodes base64url(created_at ISO + ":" + id) and decodes it back', () => {
    const position = {
      createdAt: '2026-10-18T06:00:00.000Z',
      id: '01920000-0000-7000-8000-000000000051',
    };
    const cursor = encodeWithdrawalCursor(position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(cursor, 'base64url').toString('utf8')).toBe(
      `${position.createdAt}:${position.id}`,
    );
    expect(decodeWithdrawalCursor(cursor)).toEqual(position);
  });

  it('refuses a cursor that is not one of ours', () => {
    expect(decodeWithdrawalCursor('not base64url!')).toBeNull();
    expect(decodeWithdrawalCursor(Buffer.from('no-colon').toString('base64url'))).toBeNull();
    expect(
      decodeWithdrawalCursor(
        Buffer.from('2026-10-18T06:00:00.000Z:not-a-uuid').toString('base64url'),
      ),
    ).toBeNull();
    expect(
      decodeWithdrawalCursor(
        Buffer.from('yesterday:01920000-0000-7000-8000-000000000051').toString('base64url'),
      ),
    ).toBeNull();
  });

  it('renders an instant as +08:00 civil time with milliseconds', () => {
    expect(chinaIso(new Date('2026-10-22T16:00:00.000Z'))).toBe('2026-10-23T00:00:00.000+08:00');
    expect(chinaIso(new Date('2026-12-31T15:59:59.999Z'))).toBe('2026-12-31T23:59:59.999+08:00');
    expect(chinaIso(new Date('2026-12-31T16:00:00.001Z'))).toBe('2027-01-01T00:00:00.001+08:00');
  });

  it('names the refused field', () => {
    expect(new WithdrawalReadError(['cursor']).fields).toEqual(['cursor']);
  });
});
