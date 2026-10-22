import { describe, expect, it } from 'vitest';
import { lateUploadAction } from './export-worker.ts';

describe('lateUploadAction (a timed-out put that landed later)', () => {
  it('[AC-B1-34f] a task done under another run expires', () => {
    expect(lateUploadAction({ status: 'done', row_version: 9 }, 4)).toBe('expire');
  });

  it('[AC-B1-34f] failed / pending / running / cancelled / expired rows are left', () => {
    for (const status of ['failed', 'pending', 'running', 'cancelled', 'expired']) {
      expect(lateUploadAction({ status, row_version: 9 }, 4)).toBe('none');
    }
  });

  it('[AC-B1-34f] a done row under the own token or a missing row is left', () => {
    expect(lateUploadAction({ status: 'done', row_version: 4 }, 4)).toBe('none');
    expect(lateUploadAction(undefined, 4)).toBe('none');
  });
});
