// Unit tests of the page_versions.status transition table (F1-09f 裁定 13).
import { expect, it } from 'vitest';
import {
  PageVersionTransitionError,
  isPageVersionStatus,
  transitionPageVersion,
} from './version-status.ts';

it('[F1-09f 裁定13#1] draft → published and published → rolled_back are the legal changes', () => {
  expect(transitionPageVersion('draft', 'published')).toEqual({ from: 'draft', to: 'published' });
  expect(transitionPageVersion('published', 'rolled_back')).toEqual({
    from: 'published',
    to: 'rolled_back',
  });
});

it('[F1-09f 裁定13#2] every other change, same-status rewrites and unknown values throw', () => {
  for (const [from, to] of [
    ['draft', 'rolled_back'],
    ['draft', 'draft'],
    ['published', 'draft'],
    ['published', 'published'],
    ['rolled_back', 'published'],
    ['rolled_back', 'draft'],
    ['rolled_back', 'rolled_back'],
    ['draft', 'archived'],
    ['unknown', 'published'],
    [null, 'published'],
    [undefined, 'draft'],
  ] as const) {
    expect(() => transitionPageVersion(from, to)).toThrow(PageVersionTransitionError);
  }
});

it('[F1-09f 裁定13#3] isPageVersionStatus accepts only the three stored values', () => {
  expect(['draft', 'published', 'rolled_back'].every(isPageVersionStatus)).toBe(true);
  expect([null, undefined, '', 'Draft', 1].some(isPageVersionStatus)).toBe(false);
});
