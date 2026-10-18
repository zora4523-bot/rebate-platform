// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EDITED, HOME, VERSIONS, createServer, failure } from './fixtures.ts';
import {
  button,
  click,
  editor,
  enabled,
  input,
  loaded,
  mainElement,
  message,
  mount,
  noStepUp,
  settled,
  FLOW_TIMEOUT,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it(
  '[AC-F1-09l-DRAFT#1] 整页 JSON 保存只传 sections 与页 revision；双击一次、在途禁用、显示新草稿并重读',
  async () => {
    const server = createServer();
    await mount(server);
    await loaded();
    await input(editor(), EDITED);
    const before = server.requests('GET', HOME).length;
    const release = server.hold('POST', VERSIONS);
    try {
      const save = button(mainElement(), /保存草稿/);
      await act(async () => {
        fireEvent.click(save);
        fireEvent.click(save);
      });
      await waitFor(() => expect(server.requests('POST', VERSIONS)).toHaveLength(1));
      expect(enabled(save)).toBe(false);
      expect(server.requests('POST', VERSIONS)[0]!.body).toEqual({
        sections: JSON.parse(EDITED),
        expected_revision: 19,
      });
    } finally {
      await act(async () => release());
    }
    await message(/草稿\s*v9|v9\s*草稿/);
    await waitFor(() => expect(server.requests('GET', HOME).length).toBeGreaterThan(before));
    await settled(server);
    expect(server.requests('POST')).toHaveLength(1);
    noStepUp(server);
  },
  FLOW_TIMEOUT,
);

it.each([
  { id: 2, value: '{oops', hint: /JSON|语法|格式/ },
  { id: 3, value: '{"sections":[]}', hint: /数组/ },
  { id: 4, value: 'null', hint: /数组/ },
])('[AC-F1-09l-DRAFT#$id] 本地无效输入 $value 不发请求并保留文本', async ({ value, hint }) => {
  const { server } = await mount();
  await loaded();
  await input(editor(), value);
  await click(button(mainElement(), /保存草稿/));
  await settled(server);
  await message(hint);
  expect(editor().value).toBe(value);
  expect(server.requests('POST')).toEqual([]);
});

it('[AC-F1-09l-DRAFT#5] 20001 每条点路径单独展示并提示；不猜内容规则、不清空输入', async () => {
  const server = createServer();
  const fields = ['sections.0.id', 'sections.3.data_source.channel', 'sections.2.condition.login'];
  server.once('POST', VERSIONS, () => failure(20001, { fields }, '参数错误'));
  await mount(server);
  await loaded();
  await input(editor(), EDITED);
  await click(button(mainElement(), /保存草稿/));
  await message(/参数错误|校验失败/);
  for (const field of fields) {
    // Distinct rendered elements, not a single joined JSON dump of data.fields.
    const matches = Array.from(
      mainElement().querySelectorAll('li, [role="alert"], p, div, span'),
    ).filter(
      (node) =>
        (node.textContent ?? '').includes(field) &&
        fields.filter((path) => (node.textContent ?? '').includes(path)).length === 1,
    );
    expect(matches.length, field).toBeGreaterThan(0);
  }
  expect(editor().value).toBe(EDITED);
  expect(server.requests('POST', VERSIONS)[0]!.body).toEqual({
    sections: JSON.parse(EDITED),
    expected_revision: 19,
  });
  expect(server.requests('POST')).toHaveLength(1);
});

it('[AC-F1-09l-DRAFT#6] 空列表第一次保存 home 用 revision 0，成功后可读新版本', async () => {
  const server = createServer([]);
  await mount(server);
  await waitFor(() => expect(editor().value.trim()).toBe('[]'));
  await click(button(mainElement(), /保存草稿/));
  await message(/草稿\s*v1|v1\s*草稿/);
  expect(server.requests('POST', VERSIONS)).toHaveLength(1);
  expect(server.requests('POST', VERSIONS)[0]!.body).toEqual({
    sections: [],
    expected_revision: 0,
  });
  expect(server.requests('GET', HOME).length).toBeGreaterThan(0);
});
