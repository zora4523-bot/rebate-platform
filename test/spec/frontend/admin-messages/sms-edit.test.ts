// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  BANNED_WORD,
  LIST,
  PHONE,
  PREVIEW,
  SIGN,
  TEMPLATE,
  VERIFY,
  channelPath,
  createServer,
  failure,
  smsPath,
  type Server,
} from './fixtures.ts';
import {
  ACCEPTED,
  CONFLICT,
  FLOW_TIMEOUT,
  KEPT,
  LABEL,
  NOT_ACCEPTED,
  NO_PHONE,
  SAVED,
  actions,
  assertVerified,
  assertWrite,
  bodyText,
  cancelStepUp,
  choose,
  click,
  expectFieldError,
  fill,
  mount,
  openChannels,
  openDrawer,
  settle,
  settled,
  smsRow,
  squash,
  stepUpDialog,
  stepUpOpen,
  submitOf,
  textbox,
  toggle,
  verify,
} from './helpers.ts';

/** The parts adminRegisterNotifySms accepts in its body. */
const BODY_KEYS = [
  'sign_name',
  'template_code',
  'template_type',
  'preview_text',
  'sample',
  'row_version',
];

/** Submits the drawer, checks nothing is written before the step-up, verifies, waits for PUT. */
async function submit(server: Server, drawer: HTMLElement, code: string): Promise<void> {
  await click(submitOf(drawer));
  const modal = await stepUpDialog();
  expect(server.requests('PUT')).toEqual([]);
  await verify(modal);
  await waitFor(() => expect(server.requests('PUT', smsPath(code))).toHaveLength(1));
  await settled(server);
}

/** Opens SMS_CODE, replaces its template CODE and submits. */
async function replaceSmsCodeTemplate(server: Server): Promise<HTMLElement> {
  const drawer = await openDrawer('SMS_CODE');
  await fill(textbox(drawer, LABEL.template), TEMPLATE.replacement);
  await submit(server, drawer, 'SMS_CODE');
  return drawer;
}

function rowKeepsOldTemplate(server: Server): void {
  const text = squash(smsRow('SMS_CODE').textContent);
  expect(text).toContain(TEMPLATE.smsCode);
  expect(text).not.toContain(TEMPLATE.replacement);
  expect(server.item('SMS_CODE').sms_registrations[0]!.registration!.template_code).toBe(
    TEMPLATE.smsCode,
  );
}

it(
  '[AC-F1-06zv-EDIT#1] 编辑抽屉显示定义的变量并带出当前登记；换模板 CODE → 动态码 → PUT（query variant、row_version），受理后写明测试发送号码并更新列表',
  async () => {
    const { server, directFetch } = await mount();
    const drawer = await openDrawer('SMS_CODE');
    expect(squash(drawer.textContent)).toContain('code');
    expect(textbox(drawer, LABEL.sign).value).toBe(SIGN);
    expect(textbox(drawer, LABEL.template).value).toBe(TEMPLATE.smsCode);
    expect(textbox(drawer, LABEL.preview).value).toBe(PREVIEW.smsCode);
    await fill(textbox(drawer, LABEL.template), TEMPLATE.replacement);
    await submit(server, drawer, 'SMS_CODE');
    const [request] = server.requests('PUT', smsPath('SMS_CODE'));
    expect(request!.query).toEqual({ variant: 'default' });
    expect(request!.body).toMatchObject({
      sign_name: SIGN,
      template_code: TEMPLATE.replacement,
      template_type: 'verify',
      preview_text: PREVIEW.smsCode,
      row_version: 2,
    });
    expect(Object.keys(request!.body as object).filter((key) => !BODY_KEYS.includes(key))).toEqual(
      [],
    );
    assertWrite(request!, 'test-totp-1');
    assertVerified(server, 1);
    await waitFor(() => expect(bodyText()).toMatch(ACCEPTED));
    expect(bodyText()).toContain(PHONE);
    await waitFor(() =>
      expect(squash(smsRow('SMS_CODE').textContent)).toContain(TEMPLATE.replacement),
    );
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#2] 登记未登记的变体：显示该变体的变量，填签名 / 模板 CODE / 类型 / 预览正文后提交，受理后该行变为已登记',
  async () => {
    const { server } = await mount();
    const drawer = await openDrawer('WD_REJECTED', 'negative_balance');
    expect(squash(drawer.textContent)).toContain('reason');
    const preview = '提现未通过：${reason}，请在钱包查看余额';
    await fill(textbox(drawer, LABEL.sign), SIGN);
    await fill(textbox(drawer, LABEL.template), TEMPLATE.fresh);
    await choose(drawer, LABEL.type, /通知/);
    await fill(textbox(drawer, LABEL.preview), preview);
    await submit(server, drawer, 'WD_REJECTED');
    const [request] = server.requests('PUT', smsPath('WD_REJECTED'));
    expect(request!.query).toEqual({ variant: 'negative_balance' });
    expect(request!.body).toMatchObject({
      sign_name: SIGN,
      template_code: TEMPLATE.fresh,
      template_type: 'notice',
      preview_text: preview,
      row_version: 0,
    });
    await waitFor(() => expect(bodyText()).toMatch(ACCEPTED));
    expect(bodyText()).toContain(PHONE);
    await waitFor(() => {
      const row = smsRow('WD_REJECTED', 'negative_balance');
      expect(squash(row.textContent)).toContain(TEMPLATE.fresh);
      expect(squash(row.textContent)).not.toContain('未登记');
      expect(actions(row, /^编辑/)).toHaveLength(1);
    });
    expect(squash(smsRow('WD_REJECTED', 'default').textContent)).toContain('未登记');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#3] 只改预览正文（签名与模板 CODE 不变）：无需测试发送，提示已保存并更新列表',
  async () => {
    const { server } = await mount();
    const drawer = await openDrawer('WD_FAILED');
    const text = squash(drawer.textContent);
    expect(text).toContain('reason');
    expect(text).toContain('amount');
    const preview = '提现打款未成功：${reason}，${amount} 已退回可提现余额';
    await fill(textbox(drawer, LABEL.preview), preview);
    await submit(server, drawer, 'WD_FAILED');
    expect(server.requests('PUT', smsPath('WD_FAILED'))[0]!.body).toMatchObject({
      sign_name: SIGN,
      template_code: TEMPLATE.wdFailed,
      template_type: 'notice',
      preview_text: preview,
      row_version: 1,
    });
    await waitFor(() => expect(bodyText()).toMatch(SAVED));
    await waitFor(() => expect(squash(smsRow('WD_FAILED').textContent)).toContain(squash(preview)));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#4] 未登记验证手机号（10003 verify_phone_missing）：提示先登记验证手机号，不再弹动态码，列表不变',
  async () => {
    const server = createServer(undefined, { verifyPhone: null });
    await mount(server);
    await replaceSmsCodeTemplate(server);
    await waitFor(() => expect(bodyText()).toMatch(NO_PHONE));
    await settle();
    expect(stepUpOpen()).toBe(false);
    expect(server.requests('PUT')).toHaveLength(1);
    assertVerified(server, 1);
    rowKeepsOldTemplate(server);
  },
  FLOW_TIMEOUT,
);

it.each([
  {
    name: '20001 fields=[sign_name, template_code]（服务商拒收签名或模板）',
    reply: () => failure(20001, { fields: ['sign_name', 'template_code'] }),
    fields: true,
  },
  {
    name: '42901（服务商限频）',
    reply: () => failure(42901, null, '请求过于频繁', { 'Retry-After': '30' }),
    fields: false,
  },
  { name: '50301（服务商不可用）', reply: () => failure(50301), fields: false },
  { name: '50401（超时 / 未知）', reply: () => failure(50401), fields: false },
])(
  '[AC-F1-06zv-EDIT#5] 测试发送未受理（$name）：提示未受理、原配置继续生效，列表不变',
  async ({ reply, fields }) => {
    const server = createServer();
    server.once('PUT', smsPath('SMS_CODE'), reply);
    await mount(server);
    const drawer = await replaceSmsCodeTemplate(server);
    await waitFor(() => {
      expect(bodyText()).toMatch(NOT_ACCEPTED);
      expect(bodyText()).toMatch(KEPT);
    });
    if (fields) {
      await expectFieldError(textbox(drawer, LABEL.sign));
      await expectFieldError(textbox(drawer, LABEL.template));
    }
    expect(server.requests('PUT')).toHaveLength(1);
    rowKeepsOldTemplate(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#6] 预览正文被拒（20001 fields=[preview_text]，如变量不一致）：在预览正文旁提示',
  async () => {
    const { server } = await mount();
    const drawer = await openDrawer('WD_FAILED');
    await fill(textbox(drawer, LABEL.preview), '提现打款未成功：${reason}，金额已退回余额');
    await submit(server, drawer, 'WD_FAILED');
    await expectFieldError(textbox(drawer, LABEL.preview));
    expect(squash(smsRow('WD_FAILED').textContent)).toContain(squash(PREVIEW.wdFailed));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#7] 预览正文含禁用词（20001 fields=[preview_text, 禁用词]）：提示里写出禁用词',
  async () => {
    const { server } = await mount();
    const drawer = await openDrawer('WD_FAILED');
    await fill(
      textbox(drawer, LABEL.preview),
      `提现打款未成功：\${reason}，\${amount} 已退回余额，${BANNED_WORD}`,
    );
    await submit(server, drawer, 'WD_FAILED');
    await expectFieldError(textbox(drawer, LABEL.preview), BANNED_WORD);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#8] 保存遇 20902：提示并重新拉列表',
  async () => {
    const server = createServer();
    server.once('PUT', smsPath('SMS_CODE'), () => {
      server.item('SMS_CODE').row_version = 5;
      return failure(20902, { resource: 'notify' });
    });
    await mount(server);
    await replaceSmsCodeTemplate(server);
    await waitFor(() => expect(server.requests('GET', LIST)).toHaveLength(2));
    await waitFor(() => expect(bodyText()).toMatch(CONFLICT));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#9] row_version 取该编码当前值：先开关后登记，PUT 用开关返回的 row_version，并各自验证动态码',
  async () => {
    const { server } = await mount();
    await openChannels('WD_FAILED');
    await click(toggle('push', 'WD_FAILED'));
    await verify(await stepUpDialog());
    await waitFor(() => expect(server.requests('PATCH', channelPath('WD_FAILED'))).toHaveLength(1));
    await settled(server);
    await waitFor(() =>
      expect(toggle('push', 'WD_FAILED').getAttribute('aria-checked')).toBe('false'),
    );
    const drawer = await openDrawer('WD_FAILED');
    await fill(
      textbox(drawer, LABEL.preview),
      '提现打款未成功：${reason}，${amount} 已退回可提现余额',
    );
    await submit(server, drawer, 'WD_FAILED');
    const put = server.requests('PUT', smsPath('WD_FAILED'))[0]!;
    expect(put.body).toMatchObject({ row_version: 2 });
    assertWrite(put, 'test-totp-2');
    assertVerified(server, 2);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#10] 抽屉里取消动态码：不验证、不保存',
  async () => {
    const { server } = await mount();
    const drawer = await openDrawer('SMS_CODE');
    await fill(textbox(drawer, LABEL.template), TEMPLATE.replacement);
    await click(submitOf(drawer));
    await cancelStepUp(await stepUpDialog());
    await waitFor(() => expect(stepUpOpen()).toBe(false));
    await settled(server);
    expect(server.requests('POST', VERIFY)).toEqual([]);
    expect(server.requests('PUT')).toEqual([]);
    rowKeepsOldTemplate(server);
  },
  FLOW_TIMEOUT,
);
