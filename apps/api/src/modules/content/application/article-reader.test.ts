import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { ArticleHelpSectionFilterError } from '../domain/articles.ts';
import { ArticleReader, type ArticleStore } from './article-reader.ts';

const AT = '2026-10-20T01:00:00.000001Z';
const ID = '0199f102-cccc-7000-8000-000000000001';

function store(seen: unknown[]): ArticleStore {
  return {
    list: async (input) => {
      seen.push(input);
      return [
        {
          id: ID,
          category: 'help',
          title: '帮助',
          version: 1,
          published_at: AT,
          notice_closable: true,
          notice_content_version: 1,
          notice_end_at: null,
          help_section: 'invite',
        },
      ];
    },
    detail: async () => null,
  };
}

it('[AC-F1-02zs#4] a help_section filter with another category is refused before the cursor', async () => {
  const seen: unknown[] = [];
  const reader = new ArticleReader(store(seen), new FixedClock(AT));
  await expect(
    reader.list('app', { category: 'rule', help_section: 'invite', cursor: 'broken' }),
  ).rejects.toBeInstanceOf(ArticleHelpSectionFilterError);
  expect(seen).toEqual([]);
});

it('[AC-F1-02zs#5] the filter reaches the store and the cursor stays unbound to it', async () => {
  const seen: unknown[] = [];
  const reader = new ArticleReader(store(seen), new FixedClock(AT));
  const page = await reader.list('app', { category: 'help', help_section: 'invite', limit: 1 });
  expect(seen[0]).toMatchObject({ category: 'help', helpSection: 'invite', take: 2 });
  expect(page.items[0]).toHaveProperty('help_section', 'invite');
  await reader.list('app', { category: 'help' });
  expect(seen[1]).toMatchObject({ helpSection: undefined });
});
