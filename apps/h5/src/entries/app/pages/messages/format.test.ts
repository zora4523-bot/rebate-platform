import { expect, it } from 'vitest';
import {
  formatMessageTime,
  graphemes,
  markLoadedRead,
  shortTitle,
  targetOf,
  type InboxMessage,
} from './format.ts';

const NOW = Date.parse('2026-10-22T12:00:00+08:00');

function message(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    message_id: 'm1',
    code: 'ORDER_TRACKED',
    title: 'title',
    body: 'body',
    created_at: '2026-10-22T08:00:00+08:00',
    read_at: null,
    route: null,
    ...overrides,
  };
}

it('times use Shanghai calendar days: today and yesterday with the minute', () => {
  expect(formatMessageTime('2026-10-21T16:30:00Z', NOW)).toBe('今天 00:30');
  expect(formatMessageTime('2026-10-21T23:59:00+08:00', NOW)).toBe('昨天 23:59');
  expect(formatMessageTime('2026-10-21T00:00:00+08:00', NOW)).toBe('昨天 00:00');
});

it('older times show MM-DD in the same Shanghai year and the full date otherwise', () => {
  expect(formatMessageTime('2026-10-20T23:59:59+08:00', NOW)).toBe('10-20');
  expect(formatMessageTime('2025-12-31T16:00:00Z', NOW)).toBe('01-01');
  expect(formatMessageTime('2025-12-31T08:00:00+08:00', NOW)).toBe('2025-12-31');
});

it('an unparseable time is shown as is', () => {
  expect(formatMessageTime('not a time', NOW)).toBe('not a time');
});

it('short titles are kept whole; long ones keep whole graphemes and end with an ellipsis', () => {
  const flag = '\u{1F1E8}\u{1F1F3}';
  const family = ['\u{1F468}', '\u{1F469}', '\u{1F467}'].join('\u{200D}');
  expect(shortTitle(`ab${flag}`, 3)).toBe(`ab${flag}`);
  expect(shortTitle(`a${family}${flag}e\u{301}`, 2)).toBe(`a${family}\u{2026}`);
  expect(graphemes(`${flag}e\u{301}`)).toEqual([flag, 'e\u{301}']);
});

it('only messages with a non-empty route are clickable and the route is passed unchanged', () => {
  expect(targetOf(message())).toBeNull();
  expect(targetOf(message({ route: { route: '' } }))).toBeNull();
  const route = { route: 'OrderDetail', params: { order_id: 'o1' } };
  expect(targetOf(message({ route }))).toBe(route);
});

it('marking loaded messages read touches only unread ones and reports no change as null', () => {
  const unread = message({ message_id: 'a' });
  const read = message({ message_id: 'b', read_at: '2026-10-01T00:00:00Z' });
  const other = message({ message_id: 'c' });
  const at = '2026-10-22T04:00:00.000Z';
  expect(markLoadedRead([unread, read, other], new Set(['a']), at)).toEqual([
    { ...unread, read_at: at },
    read,
    other,
  ]);
  expect(markLoadedRead([unread, read, other], null, at)).toEqual([
    { ...unread, read_at: at },
    read,
    { ...other, read_at: at },
  ]);
  expect(markLoadedRead([read], null, at)).toBeNull();
});
