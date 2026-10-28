// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  LIST,
  PHONE,
  TEMPLATE,
  VERIFY,
  createServer,
  enablePath,
  failure,
  pendingPath,
  retestPath,
  type ProviderOutcome,
  type Server,
} from './fixtures.ts';
import {
  ACCEPTED,
  CONFLICT,
  DISCARD,
  ENABLE,
  FLOW_TIMEOUT,
  KEPT,
  LATER,
  NOT_ACCEPTED,
  NO_PHONE,
  RETEST,
  REVISE,
  SEND,
  STATUS,
  TEST_SEND,
  action,
  answerConfirm,
  assertVerified,
  assertWrite,
  bodyText,
  click,
  confirmOpen,
  dialogWith,
  dialogsWith,
  editablePhone,
  extraKeys,
  freshText,
  mount,
  openSms,
  queryOf,
  settle,
  settled,
  showsPhone,
  smsRow,
  snapshotText,
  squash,
  statusOf,
  stepUpDialog,
  stepUpOpen,
  usable,
  verify,
  type TextSnapshot,
} from './helpers.ts';

/** The parts adminRetestNotifySms accepts in its body. */
const RETEST_FIELDS = ['sample', 'row_version'];

function rowText(code: string, variant = 'default'): string {
  return squash(smsRow(code, variant).textContent);
}
function retests(server: Server, code: string) {
  return server.requests('POST', retestPath(code));
}
function enables(server: Server, code: string) {
  return server.requests('POST', enablePath(code));
}

/**
 * Row 【测试发送 / 重新测试】 with a verify phone: the test-send dialog (no step-up, nothing sent),
 * 【发送测试短信】 → step-up → one POST …/sms/pending/test.
 */
async function retestFromRow(
  server: Server,
  code: string,
  name: RegExp,
  variant = 'default',
): Promise<{ modal: HTMLElement; before: TextSnapshot }> {
  await openSms(code, variant);
  const before = snapshotText();
  await click(action(smsRow(code, variant), name));
  const modal = await dialogWith(SEND);
  expect(stepUpOpen()).toBe(false);
  expect(server.writes()).toEqual([]);
  await click(action(modal, SEND));
  const verification = await stepUpDialog();
  expect(server.writes()).toEqual([]);
  await verify(verification);
  await waitFor(() => expect(retests(server, code)).toHaveLength(1));
  await settled(server);
  return { modal, before };
}

it(
  '[AC-F1-06zv-ROW#1] 测试失败行【重新测试】：先弹测试发送（脱敏号码、不可改），【发送测试短信】→ 动态码 → POST …/sms/pending/test（variant、row_version），已受理后该行「待测试」旁注「测试已受理」',
  async () => {
    const { server, directFetch } = await mount();
    await openSms('WD_FAILED');
    await click(action(smsRow('WD_FAILED'), RETEST));
    const modal = await dialogWith(SEND);
    expect(showsPhone(modal), 'the masked verify phone').toBe(true);
    expect(editablePhone(modal), 'the phone cannot be edited').toEqual([]);
    expect(stepUpOpen()).toBe(false);
    await click(action(modal, SEND));
    await verify(await stepUpDialog());
    await waitFor(() => expect(retests(server, 'WD_FAILED')).toHaveLength(1));
    const [request] = retests(server, 'WD_FAILED');
    expect(queryOf(request!)).toEqual({ variant: 'default' });
    expect(request!.body).toMatchObject({ row_version: 5 });
    expect(extraKeys(request!, RETEST_FIELDS)).toEqual([]);
    assertWrite(request!, 'test-totp-1');
    assertVerified(server, 1);
    await settled(server);
    const result = await dialogWith(LATER);
    expect(squash(result.textContent)).toMatch(ACCEPTED);
    await click(action(result, LATER));
    await settle();
    await waitFor(() => expect(statusOf('WD_FAILED')).toContain(STATUS.pending));
    expect(statusOf('WD_FAILED')).toContain(STATUS.accepted);
    expect(statusOf('WD_FAILED')).not.toContain(STATUS.failed);
    expect(enables(server, 'WD_FAILED')).toEqual([]);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-ROW#2] 重新测试已受理后【启用新配置】（资金类、持 content.fund_terms）：动态码 → POST …/sms/pending/enable，该行「已启用」新模板 CODE',
  async () => {
    const server = createServer();
    await mount(server);
    await retestFromRow(server, 'WD_FAILED', RETEST);
    const result = await dialogWith(LATER);
    await click(action(result, ENABLE));
    const verification = await stepUpDialog();
    expect(enables(server, 'WD_FAILED')).toEqual([]);
    await verify(verification);
    await waitFor(() => expect(enables(server, 'WD_FAILED')).toHaveLength(1));
    const [request] = enables(server, 'WD_FAILED');
    expect(queryOf(request!)).toEqual({ variant: 'default' });
    // The retest raised row_version from 5 to 6.
    expect(request!.body).toEqual({ row_version: 6 });
    assertWrite(request!, 'test-totp-2');
    await settled(server);
    await waitFor(() => expect(statusOf('WD_FAILED')).toContain(STATUS.enabled));
    expect(rowText('WD_FAILED')).toContain(TEMPLATE.wdFailedPending);
    expect(rowText('WD_FAILED')).not.toContain(TEMPLATE.wdFailedActive);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-ROW#3] 页面读到的 verify_phone_masked 为 null：行【测试发送】直接弹「先登记验证手机号」，不要动态码、不请求',
  async () => {
    const server = createServer(undefined, { verifyPhone: null });
    await mount(server);
    await openSms('WD_REJECTED', 'negative_balance');
    const before = snapshotText();
    await click(action(smsRow('WD_REJECTED', 'negative_balance'), TEST_SEND));
    await waitFor(() => expect(freshText(before)).toMatch(NO_PHONE));
    await settled(server);
    expect(stepUpOpen()).toBe(false);
    expect(usable(document.body, SEND)).toEqual([]);
    expect(server.requests('POST', VERIFY)).toEqual([]);
    expect(server.writes()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-ROW#4] 单独测试时号码已失效（10003 verify_phone_missing）：弹「先登记验证手机号」，不再弹动态码，该行不变',
  async () => {
    const server = createServer(undefined, { mePhone: PHONE, verifyPhone: null });
    await mount(server);
    const variant = 'negative_balance';
    const { before } = await retestFromRow(server, 'WD_REJECTED', TEST_SEND, variant);
    await waitFor(() => expect(freshText(before)).toMatch(NO_PHONE));
    await settle();
    expect(stepUpOpen()).toBe(false);
    expect(retests(server, 'WD_REJECTED')).toHaveLength(1);
    assertVerified(server, 1);
    expect(dialogsWith(LATER)).toEqual([]);
    expect(statusOf('WD_REJECTED', 'negative_balance')).toContain(STATUS.pending);
    expect(statusOf('WD_REJECTED', 'negative_balance')).not.toContain(STATUS.accepted);
  },
  FLOW_TIMEOUT,
);

it.each([
  { name: '50301 拒收或出错', outcome: 'rejected' },
  { name: '50401 超时或未知', outcome: 'timeout' },
] satisfies { name: string; outcome: ProviderOutcome }[])(
  '[AC-F1-06zv-ROW#5] 行【测试发送】未受理（$name）：弹窗写明未受理、原配置继续生效，给【修改配置】不给【启用新配置】；刷新列表，该行「测试失败」',
  async ({ outcome }) => {
    const server = createServer(undefined, { provider: outcome });
    await mount(server);
    const { before } = await retestFromRow(server, 'UNION_AUTH_EXPIRING', TEST_SEND);
    const result = await dialogWith(REVISE);
    await waitFor(() => {
      const text = freshText(before);
      expect(text).toMatch(NOT_ACCEPTED);
      expect(text).toMatch(KEPT);
    });
    expect(usable(result, ENABLE)).toEqual([]);
    await waitFor(() => expect(server.requests('GET', LIST).length).toBeGreaterThanOrEqual(2));
    await settled(server);
    await waitFor(() => expect(statusOf('UNION_AUTH_EXPIRING')).toContain(STATUS.failed));
    expect(rowText('UNION_AUTH_EXPIRING')).toContain(TEMPLATE.unionActive);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-ROW#6] 【放弃新配置】：先确认（取消则不请求），确认后 DELETE …/sms/pending（variant、row_version），不要动态码；在用配置不动，该行回到「已启用」',
  async () => {
    const { server } = await mount();
    await openSms('UNION_AUTH_EXPIRING');
    await click(action(smsRow('UNION_AUTH_EXPIRING'), DISCARD));
    await waitFor(() => expect(confirmOpen(), 'a confirmation first').toBe(true));
    await answerConfirm(false);
    await settled(server);
    expect(server.writes()).toEqual([]);
    await click(action(smsRow('UNION_AUTH_EXPIRING'), DISCARD));
    await answerConfirm(true);
    await waitFor(() =>
      expect(server.requests('DELETE', pendingPath('UNION_AUTH_EXPIRING'))).toHaveLength(1),
    );
    const [request] = server.requests('DELETE', pendingPath('UNION_AUTH_EXPIRING'));
    expect(queryOf(request!)).toEqual({ variant: 'default', row_version: '3' });
    expect(request!.headers.get('X-Step-Up-Token')).toBeNull();
    expect(request!.headers.get('Authorization')).toBe('Bearer example-admin-token');
    expect(stepUpOpen()).toBe(false);
    expect(server.requests('POST', VERIFY)).toEqual([]);
    await settled(server);
    await waitFor(() => expect(statusOf('UNION_AUTH_EXPIRING')).toContain(STATUS.enabled));
    expect(rowText('UNION_AUTH_EXPIRING')).toContain(TEMPLATE.unionActive);
    expect(rowText('UNION_AUTH_EXPIRING')).not.toContain(TEMPLATE.unionPending);
    expect(server.writes()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-ROW#7] 行【重新测试】遇 20902：提示并重新拉列表',
  async () => {
    const server = createServer();
    server.once('POST', retestPath('WD_FAILED'), () => {
      server.item('WD_FAILED').row_version = 9;
      return failure(20902, undefined, '状态已变化，请刷新后重试');
    });
    await mount(server);
    await retestFromRow(server, 'WD_FAILED', RETEST);
    await waitFor(() => expect(server.requests('GET', LIST)).toHaveLength(2));
    await waitFor(() => expect(bodyText()).toMatch(CONFLICT));
  },
  FLOW_TIMEOUT,
);
