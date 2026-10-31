import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { ArticleListFilterError } from '../domain/articles.ts';
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
          faq_rank: 4,
          body: JSON.stringify({
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '首段' }] }],
          }),
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
  ).rejects.toBeInstanceOf(ArticleListFilterError);
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

it('[AC-F1-02zzp#14] faq with another category is refused before the cursor; help_section first', async () => {
  const seen: unknown[] = [];
  const reader = new ArticleReader(store(seen), new FixedClock(AT));
  for (const faq of [true, false]) {
    const refused = reader.list('app', { category: 'rule', faq, cursor: 'broken' });
    await expect(refused).rejects.toMatchObject({ fields: ['faq'] });
  }
  await expect(
    reader.list('app', { category: 'notice', help_section: 'invite', faq: true }),
  ).rejects.toMatchObject({ fields: ['help_section', 'faq'] });
  expect(seen).toEqual([]);
});

it('[AC-F1-02zzp#11] faq=true reaches the store as faqOnly; items carry summary and faq_rank', async () => {
  const seen: unknown[] = [];
  const reader = new ArticleReader(store(seen), new FixedClock(AT));
  const page = await reader.list('app', { category: 'help', faq: true });
  expect(seen[0]).toMatchObject({ faqOnly: true });
  expect(page.items[0]).toMatchObject({ summary: '首段', faq_rank: 4 });
  expect(page.items[0]).not.toHaveProperty('body');
  await reader.list('app', { category: 'help', faq: false });
  await reader.list('app', { category: 'help' });
  expect(seen[1]).toMatchObject({ faqOnly: false });
  expect(seen[2]).toMatchObject({ faqOnly: false });
});
