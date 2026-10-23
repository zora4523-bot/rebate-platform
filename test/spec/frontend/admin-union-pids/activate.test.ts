// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ACTIVATE_PARTS,
  MAX_EVIDENCE_BYTES,
  PENDING_JD_ID,
  PENDING_TAOBAO_ID,
  PID,
  PIDS,
  VERIFY,
  activateUrl,
  createServer,
  failure,
  screenshot,
} from './fixtures.ts';
import {
  CONFLICT,
  FLOW_TIMEOUT,
  LABEL,
  actions,
  assertVerified,
  assertWrite,
  chooseFile,
  click,
  dialog,
  fieldError,
  fileInput,
  fill,
  fillTime,
  mount,
  openActivate,
  row,
  settle,
  stepUp,
  stepUpOpen,
  submit,
  textbox,
  verify,
} from './helpers.ts';

const ACTIVATE = /启用/;
/** 30155: another PID of the same platform and scene is active; retire it first. */
const SCENE_ACTIVE = /(?:同平台同场景|同一平台同一场景|同平台.*同.*场景|该场景).*(?:启用中|已启用)/;
const CONFIRMED = '2026-10-22 09:30:00';
const CONFIRMED_ISO = '2026-10-22T09:30:00+08:00';

async function fillActivation(form: HTMLElement, file = screenshot('hjy.png', 'image/png', 2048)) {
  await fillTime(textbox(form, LABEL.confirmedAt), CONFIRMED);
  await chooseFile(form, file);
}

it(
  '[AC-F1-10gb-ACT#1] 启用：填花卷云忽略确认时间、上传截图与原因，动态码后 multipart 提交，行变为启用中',
  async () => {
    const { server } = await mount();
    const form = await openActivate(PID.pendingJd);
    await fillActivation(form);
    await fill(textbox(form, LABEL.reason), '花卷云已忽略');
    const modal = await stepUp(form);
    expect(server.requests('POST', activateUrl(PENDING_JD_ID))).toEqual([]);
    await verify(modal);
    await waitFor(() =>
      expect(server.requests('POST', activateUrl(PENDING_JD_ID))).toHaveLength(1),
    );
    const sent = server.requests('POST', activateUrl(PENDING_JD_ID))[0]!;
    assertWrite(sent);
    assertVerified(server);
    expect(sent.body).toBeUndefined();
    expect(sent.headers.get('Content-Type') ?? '').not.toMatch(/json/);
    expect(sent.form, 'multipart/form-data body').toBeDefined();
    const parts = sent.form!;
    expect([...new Set(parts.keys())].sort()).toEqual([...ACTIVATE_PARTS]);
    expect(parts.getAll('expected_row_version')).toEqual(['0']);
    const at = parts.get('hjy_ignore_confirmed_at');
    expect(typeof at).toBe('string');
    expect(Date.parse(at as string)).toBe(Date.parse(CONFIRMED_ISO));
    const evidence = parts.get('hjy_ignore_evidence');
    expect(evidence).toBeInstanceOf(Blob);
    expect((evidence as Blob).type).toBe('image/png');
    expect((evidence as Blob).size).toBe(2048);
    expect(parts.get('reason')).toBe('花卷云已忽略');
    await waitFor(() => expect(actions(row(PID.pendingJd), /^停用/)).toHaveLength(1));
    expect(actions(row(PID.pendingJd), /修改|启用/)).toEqual([]);
    expect(row(PID.pendingJd).textContent).toMatch(/2026[-/]10[-/]22/);
    expect(row(PID.pendingJd).textContent).toContain('09:30');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-ACT#2] JPEG 截图、不填原因：只发三个 part',
  async () => {
    const { server } = await mount();
    const form = await openActivate(PID.pendingJd);
    await fillActivation(form, screenshot('hjy.jpg', 'image/jpeg', 4096));
    await verify(await stepUp(form));
    await waitFor(() =>
      expect(server.requests('POST', activateUrl(PENDING_JD_ID))).toHaveLength(1),
    );
    const parts = server.requests('POST', activateUrl(PENDING_JD_ID))[0]!.form!;
    expect([...new Set(parts.keys())].sort()).toEqual(
      ACTIVATE_PARTS.filter((part) => part !== 'reason'),
    );
    expect((parts.get('hjy_ignore_evidence') as Blob).type).toBe('image/jpeg');
  },
  FLOW_TIMEOUT,
);

it.each([
  { case: '类型不是 PNG / JPEG', file: () => screenshot('hjy.gif', 'image/gif', 2048) },
  {
    case: '大于 5 MB',
    file: () => screenshot('hjy.png', 'image/png', MAX_EVIDENCE_BYTES + 1),
  },
])(
  '[AC-F1-10gb-ACT#3] 截图$case：前端在截图旁提示，不要动态码、不发请求',
  async ({ file }) => {
    const { server } = await mount();
    const form = await openActivate(PID.pendingJd);
    await fillActivation(form, file());
    await click(submit(form));
    await settle();
    await waitFor(() => fieldError(fileInput(form)));
    expect(stepUpOpen()).toBe(false);
    expect(server.requests('POST', activateUrl(PENDING_JD_ID))).toEqual([]);
    expect(server.requests('POST', VERIFY)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-ACT#4] 确认时间晚于现在：在时间旁提示，不发请求',
  async () => {
    const { server } = await mount();
    const form = await openActivate(PID.pendingJd);
    await fillTime(textbox(form, LABEL.confirmedAt), '2099-01-01 00:00:00');
    await chooseFile(form, screenshot('hjy.png', 'image/png', 2048));
    await click(submit(form));
    await settle();
    await waitFor(() => fieldError(textbox(form, LABEL.confirmedAt)));
    expect(stepUpOpen()).toBe(false);
    expect(server.requests('POST', activateUrl(PENDING_JD_ID))).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-ACT#5] 时间与截图都没填：两处都提示，不发请求',
  async () => {
    const { server } = await mount();
    const form = await openActivate(PID.pendingJd);
    await click(submit(form));
    await settle();
    await waitFor(() => fieldError(textbox(form, LABEL.confirmedAt)));
    await waitFor(() => fieldError(fileInput(form)));
    expect(stepUpOpen()).toBe(false);
    expect(server.requests('POST', activateUrl(PENDING_JD_ID))).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-ACT#6] 服务端 20001 fields 列出缺项：在确认时间与截图旁提示，不自动重发',
  async () => {
    const server = createServer();
    server.once('POST', activateUrl(PENDING_JD_ID), () =>
      failure(20001, { fields: ['hjy_ignore_confirmed_at', 'hjy_ignore_evidence'] }),
    );
    await mount(server);
    const form = await openActivate(PID.pendingJd);
    await fillActivation(form);
    await verify(await stepUp(form));
    await waitFor(() =>
      expect(server.requests('POST', activateUrl(PENDING_JD_ID))).toHaveLength(1),
    );
    const current = await dialog(ACTIVATE);
    await waitFor(() => fieldError(textbox(current, LABEL.confirmedAt)));
    await waitFor(() => fieldError(fileInput(current)));
    await settle();
    expect(server.requests('POST', activateUrl(PENDING_JD_ID))).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-ACT#7] 30155：提示同平台同场景已有启用中的推广位、请先停用；行仍待确认，不自动重发',
  async () => {
    const { server } = await mount();
    const form = await openActivate(PID.pendingTaobao);
    expect(document.body.textContent).not.toMatch(SCENE_ACTIVE);
    await fillActivation(form);
    await verify(await stepUp(form));
    await waitFor(() =>
      expect(server.requests('POST', activateUrl(PENDING_TAOBAO_ID))).toHaveLength(1),
    );
    await waitFor(() => expect(document.body.textContent).toMatch(SCENE_ACTIVE));
    expect(document.body.textContent).toMatch(/先停用/);
    await settle();
    expect(server.requests('POST', activateUrl(PENDING_TAOBAO_ID))).toHaveLength(1);
    expect(actions(row(PID.pendingTaobao), /^启用/)).toHaveLength(1);
    expect(actions(row(PID.active), /^停用/)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10gb-ACT#8] 20902（行已变化）提示刷新并重新读取列表，不自动重发',
  async () => {
    const server = createServer();
    server.once('POST', activateUrl(PENDING_JD_ID), () => {
      const index = server.state.findIndex((item) => item.pid_id === PENDING_JD_ID);
      server.state[index] = { ...server.state[index]!, pid: '4010', row_version: 1 };
      return failure(20902, { resource: 'union_pid' });
    });
    await mount(server);
    const form = await openActivate(PID.pendingJd);
    expect(document.body.textContent).not.toMatch(CONFLICT);
    await fillActivation(form);
    await verify(await stepUp(form));
    await waitFor(() => expect(document.body.textContent).toMatch(CONFLICT));
    await waitFor(() => expect(server.requests('GET', PIDS)).toHaveLength(2));
    await waitFor(() => expect(row('4010').textContent).toContain('4010'));
    await settle();
    expect(server.requests('POST', activateUrl(PENDING_JD_ID))).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);
