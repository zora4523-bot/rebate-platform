// Unit tests of the page_versions.status adapter over the generated transition (F1-09f 裁定 13, 9.14).
import { expect, it } from 'vitest';
import {
  PageVersionTransitionError,
  canChangePageVersion,
  isPageVersionStatus,
  newPageVersionStatus,
  pageVersionChange,
} from './version-status.ts';

it('[F1-09f 裁定13#1] PUBLISH takes draft to published, ROLLBACK takes published to rolled_back', () => {
  expect(pageVersionChange('draft', 'PUBLISH')).toEqual({
    from: 'draft',
    event: 'PUBLISH',
    to: 'published',
  });
  expect(pageVersionChange('published', 'ROLLBACK')).toEqual({
    from: 'published',
    event: 'ROLLBACK',
    to: 'rolled_back',
  });
});

it('[F1-09f 裁定13#2] every other change and unknown values or events throw', () => {
  for (const [from, event] of [
    ['draft', 'ROLLBACK'],
    ['published', 'PUBLISH'],
    ['rolled_back', 'PUBLISH'],
    ['rolled_back', 'ROLLBACK'],
    ['draft', 'DRAFT_SAVED'],
    ['draft', 'publish'],
    ['unknown', 'PUBLISH'],
    [null, 'PUBLISH'],
    [undefined, 'ROLLBACK'],
  ] as const) {
    expect(() => pageVersionChange(from, event)).toThrow(PageVersionTransitionError);
  }
});

it('[F1-09f 裁定13#3] isPageVersionStatus accepts only the three stored values', () => {
  expect(['draft', 'published', 'rolled_back'].every(isPageVersionStatus)).toBe(true);
  expect([null, undefined, '', 'Draft', 1].some(isPageVersionStatus)).toBe(false);
});

it('[F1-09f 9.14#1] a newly saved version row starts as draft (P1, DRAFT_SAVED)', () => {
  expect(newPageVersionStatus()).toBe('draft');
});

it('[F1-09f 9.14#2] canChangePageVersion follows the generated table', () => {
  expect(canChangePageVersion('draft', 'PUBLISH')).toBe(true);
  expect(canChangePageVersion('published', 'ROLLBACK')).toBe(true);
  expect(canChangePageVersion('published', 'PUBLISH')).toBe(false);
  expect(canChangePageVersion('rolled_back', 'PUBLISH')).toBe(false);
  expect(canChangePageVersion('draft', 'ROLLBACK')).toBe(false);
  expect(canChangePageVersion('archived', 'PUBLISH')).toBe(false);
});
