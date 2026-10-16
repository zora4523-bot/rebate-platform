import { describe, expect, it } from 'vitest';
import { inOpenReads, openScopedReader, withOpenReads } from './link-open-reads.ts';

describe('link-open-reads (B2-03d)', () => {
  it('[AC-B2-03d] inOpenReads is true only inside an open, both while pre-reading and locked', async () => {
    expect(inOpenReads()).toBe(false);
    const seen: boolean[] = [];
    await withOpenReads(
      async () => {
        seen.push(inOpenReads());
      },
      async () => {
        seen.push(inOpenReads());
      },
    );
    expect(seen).toEqual([true, true]);
    expect(inOpenReads()).toBe(false);
  });

  it('[AC-B2-03d] a load sees the scope it was started in', async () => {
    const reader = {};
    const load = async () => inOpenReads();
    expect(await openScopedReader(reader, 'k', 'flag', load)).toBe(false);
    await withOpenReads(
      async () => {
        expect(await openScopedReader(reader, 'k', 'flag', load)).toBe(true);
      },
      async () => {
        expect(await openScopedReader(reader, 'k', 'flag', load)).toBe(true);
      },
    );
  });
});
