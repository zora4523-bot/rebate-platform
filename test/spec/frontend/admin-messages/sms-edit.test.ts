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
  enablePath,
  failure,
  smsPath,
  type ProviderOutcome,
  type Server,
} from './fixtures.ts';
import {
  ACCEPTED,
  CONFLICT,
  ENABLE,
  FLOW_TIMEOUT,
  KEPT,
  LABEL,
  LATER,
  NOT_ACCEPTED,
  NO_PHONE,
  ORIGINAL,
  REVISE,
  SAVE,
  SEND,
  STATUS,
  action,
  assertVerified,
  assertWrite,
  bodyText,
  cancelStepUp,
  click,
  dialogWith,
  dialogsWith,
  editablePhone,
  expectFieldError,
  extraKeys,
  fieldError,
  fill,
  freshText,
  mount,
  openChannels,
  openDrawer,
  queryOf,
  saveDirect,
  saveExpectingFieldError,
  saveWithTest,
  settle,
  settled,
  shows,
  showsPhone,
  smsRow,
  squash,
  statusOf,
  stepUpDialog,
  stepUpOpen,
  textbox,
  toggle,
  usable,
  verify,
} from './helpers.ts';

/** The parts adminRegisterNotifySms accepts in its body. */
const REGISTER_FIELDS = [
  'sign_name',
  'template_code',
  'template_type',
  'preview_text',
  'sample',
  'row_version',
];
/** A WD_SUCCESS preview that keeps both variables (${net}, ${payout_channel_name}). */
const WD_SUCCESS_EDITED = '【凑狸】提现已到账：${net}已转入${payout_channel_name}，请查收。';
const CLAIM_PREVIEW = '【凑狸】你的补单申领有了结果：${rebate}，请在App内查看。';
const CODE_PREVIEW = '【凑狸】验证码${code}，5分钟内有效，请勿泄露。';
/** States 10 minutes while sms_code_ttl_sec is 300. */
const CODE_PREVIEW_TTL = '【凑狸】验证码${code}，10分钟内有效，请勿泄露。';

function rowText(code: string, variant = 'default'): string {
  return squash(smsRow(code, variant).textContent);
}
function puts(server: Server, code: string) {
  return server.requests('PUT', smsPath(code));
}
function enables(server: Server, code: string) {
  return server.requests('POST', enablePath(code));
}
/** Some open dialog offers a usable 【启用新配置】. */
function offersEnable(): boolean {
  return dialogsWith(ENABLE).some((node) => usable(node, ENABLE).length > 0);
}

/** Opens WD_SUCCESS, replaces its template CODE and saves through the test-send dialog. */
async function replaceWdSuccessTemplate(server: Server) {
  const drawer = await openDrawer('WD_SUCCESS');
  await fill(textbox(drawer, LABEL.template), TEMPLATE.replacement);
  const sent = await saveWithTest(server, drawer, 'WD_SUCCESS');
  return { drawer, ...sent };
}

function activeKept(server: Server): void {
  expect(server.row('WD_SUCCESS').active?.template_code).toBe(TEMPLATE.wdSuccess);
  expect(rowText('WD_SUCCESS')).toContain(TEMPLATE.wdSuccess);
}

it(
  '[AC-F1-06zv-EDIT#1] 换模板 CODE：抽屉显示该变体的变量与当前登记；【保存】先弹测试发送（脱敏号码、不可改，新配置与当前生效），【发送测试短信】→ 动态码 → PUT（query variant、row_version、类型锁定通知），已受理',
  async () => {
    const { server, directFetch } = await mount();
    const drawer = await openDrawer('WD_SUCCESS');
    // The variables are shown outside the text boxes (the preview textarea holds them too).
    expect(shows(drawer, 'net'), 'variable net shown').toBe(true);
    expect(shows(drawer, 'payout_channel_name'), 'variable payout_channel_name').toBe(true);
    expect(textbox(drawer, LABEL.sign).value).toBe(SIGN);
    expect(textbox(drawer, LABEL.template).value).toBe(TEMPLATE.wdSuccess);
    expect(textbox(drawer, LABEL.preview).value).toBe(PREVIEW.wdSuccess);
    await fill(textbox(drawer, LABEL.template), TEMPLATE.replacement);
    await click(action(drawer, SAVE));
    const modal = await dialogWith(SEND);
    expect(stepUpOpen()).toBe(false);
    expect(server.writes()).toEqual([]);
    expect(showsPhone(modal), 'the masked verify phone').toBe(true);
    expect(editablePhone(modal), 'the phone cannot be edited').toEqual([]);
    expect(squash(modal.textContent)).toContain(TEMPLATE.replacement);
    expect(squash(modal.textContent)).toContain(TEMPLATE.wdSuccess);
    await click(action(modal, SEND));
    const verification = await stepUpDialog();
    expect(server.writes()).toEqual([]);
    await verify(verification);
    await waitFor(() => expect(puts(server, 'WD_SUCCESS')).toHaveLength(1));
    const [request] = puts(server, 'WD_SUCCESS');
    expect(queryOf(request!)).toEqual({ variant: 'default' });
    expect(request!.body).toMatchObject({
      sign_name: SIGN,
      template_code: TEMPLATE.replacement,
      template_type: 'notice',
      preview_text: PREVIEW.wdSuccess,
      row_version: 2,
    });
    expect(extraKeys(request!, REGISTER_FIELDS)).toEqual([]);
    assertWrite(request!, 'test-totp-1');
    assertVerified(server, 1);
    await settled(server);
    const result = await dialogWith(LATER);
    expect(squash(result.textContent)).toMatch(ACCEPTED);
    expect(usable(result, ENABLE)).toHaveLength(1);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#2] 已受理后【稍后再启用】：只关弹窗、不请求；该行为「待测试」并旁注「测试已受理」，在用模板 CODE 仍在',
  async () => {
    const { server } = await mount();
    await replaceWdSuccessTemplate(server);
    const result = await dialogWith(LATER);
    await click(action(result, LATER));
    await settle();
    await waitFor(() => expect(dialogsWith(LATER)).toEqual([]));
    await settled(server);
    expect(enables(server, 'WD_SUCCESS')).toEqual([]);
    expect(stepUpOpen()).toBe(false);
    await waitFor(() => expect(statusOf('WD_SUCCESS')).toContain(STATUS.pending));
    expect(statusOf('WD_SUCCESS')).toContain(STATUS.accepted);
    expect(rowText('WD_SUCCESS')).toContain(TEMPLATE.replacement);
    activeKept(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#3] 已受理后【启用新配置】：动态码 → POST …/sms/pending/enable（保存返回的 row_version），该行「已启用」新模板 CODE',
  async () => {
    const { server } = await mount();
    await replaceWdSuccessTemplate(server);
    const result = await dialogWith(LATER);
    await click(action(result, ENABLE));
    const verification = await stepUpDialog();
    expect(enables(server, 'WD_SUCCESS')).toEqual([]);
    await verify(verification);
    await waitFor(() => expect(enables(server, 'WD_SUCCESS')).toHaveLength(1));
    const [request] = enables(server, 'WD_SUCCESS');
    expect(queryOf(request!)).toEqual({ variant: 'default' });
    expect(request!.body).toEqual({ row_version: 3 });
    assertWrite(request!, 'test-totp-2');
    assertVerified(server, 2);
    await settled(server);
    await waitFor(() => expect(statusOf('WD_SUCCESS')).toContain(STATUS.enabled));
    expect(statusOf('WD_SUCCESS')).not.toContain(STATUS.pending);
    expect(rowText('WD_SUCCESS')).toContain(TEMPLATE.replacement);
    expect(rowText('WD_SUCCESS')).not.toContain(TEMPLATE.wdSuccess);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#4] 只改预览正文（签名与模板 CODE 不变）：不弹测试发送，动态码后直接保存，该行仍「已启用」并显示新正文',
  async () => {
    const { server } = await mount();
    const drawer = await openDrawer('WD_SUCCESS');
    await fill(textbox(drawer, LABEL.preview), WD_SUCCESS_EDITED);
    await saveDirect(server, drawer, 'WD_SUCCESS');
    const [request] = puts(server, 'WD_SUCCESS');
    expect(request!.body).toMatchObject({
      sign_name: SIGN,
      template_code: TEMPLATE.wdSuccess,
      template_type: 'notice',
      preview_text: WD_SUCCESS_EDITED,
      row_version: 2,
    });
    assertWrite(request!, 'test-totp-1');
    expect(dialogsWith(LATER)).toEqual([]);
    await waitFor(() => expect(rowText('WD_SUCCESS')).toContain(squash(WD_SUCCESS_EDITED)));
    expect(statusOf('WD_SUCCESS')).toContain(STATUS.enabled);
    expect(statusOf('WD_SUCCESS')).not.toContain(STATUS.pending);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#5] 没有验证手机号（verify_phone_masked=null）：【保存】不弹测试发送，动态码后照常保存为「待测试」，再提示先登记验证手机号',
  async () => {
    const server = createServer(undefined, { verifyPhone: null });
    await mount(server);
    const drawer = await openDrawer('WD_SUCCESS');
    await fill(textbox(drawer, LABEL.template), TEMPLATE.replacement);
    const before = await saveDirect(server, drawer, 'WD_SUCCESS');
    expect(puts(server, 'WD_SUCCESS')[0]!.body).toMatchObject({
      template_code: TEMPLATE.replacement,
      row_version: 2,
    });
    await waitFor(() => expect(freshText(before)).toMatch(NO_PHONE));
    expect(offersEnable()).toBe(false);
    await waitFor(() => expect(statusOf('WD_SUCCESS')).toContain(STATUS.pending));
    expect(statusOf('WD_SUCCESS')).not.toContain(STATUS.accepted);
    activeKept(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#6] 页面加载后验证手机号才失效：照常弹测试发送、过动态码，保存结果为未发送时弹窗换成「先登记验证手机号」，不给【启用新配置】',
  async () => {
    const server = createServer(undefined, { mePhone: PHONE, verifyPhone: null });
    await mount(server);
    const { before } = await replaceWdSuccessTemplate(server);
    await waitFor(() => expect(freshText(before)).toMatch(NO_PHONE));
    expect(dialogsWith(LATER)).toEqual([]);
    expect(offersEnable()).toBe(false);
    await waitFor(() => expect(statusOf('WD_SUCCESS')).toContain(STATUS.pending));
    expect(statusOf('WD_SUCCESS')).not.toContain(STATUS.accepted);
  },
  FLOW_TIMEOUT,
);

it.each([
  { name: '50301 拒收或出错', outcome: 'rejected' },
  { name: '50401 超时或未知', outcome: 'timeout' },
] satisfies { name: string; outcome: ProviderOutcome }[])(
  '[AC-F1-06zv-EDIT#7] 测试发送未受理（$name）：弹窗写明未受理、原配置继续生效，给【修改配置】不给【启用新配置】；刷新列表，该行「测试失败」、在用配置不变',
  async ({ outcome }) => {
    const server = createServer(undefined, { provider: outcome });
    await mount(server);
    const { before } = await replaceWdSuccessTemplate(server);
    const result = await dialogWith(REVISE);
    await waitFor(() => {
      const text = freshText(before);
      expect(text).toMatch(NOT_ACCEPTED);
      expect(text).toMatch(KEPT);
    });
    expect(usable(result, ENABLE)).toEqual([]);
    // The failed pending registration was saved anyway (row_version moved): read the list again.
    await waitFor(() => expect(server.requests('GET', LIST).length).toBeGreaterThanOrEqual(2));
    await settled(server);
    await waitFor(() => expect(statusOf('WD_SUCCESS')).toContain(STATUS.failed));
    activeKept(server);
    expect(server.requests('PUT')).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#8] 首次登记（【登记】，没有在用配置）：类型锁定通知，测试发送与已受理弹窗不提原配置 / 当前生效，保存后为「待测试」',
  async () => {
    const { server } = await mount();
    const drawer = await openDrawer('CLAIM_RESULT');
    expect(shows(drawer, 'rebate'), 'variable rebate shown').toBe(true);
    await fill(textbox(drawer, LABEL.sign), SIGN);
    await fill(textbox(drawer, LABEL.template), TEMPLATE.fresh);
    await fill(textbox(drawer, LABEL.preview), CLAIM_PREVIEW);
    const { modal } = await saveWithTest(server, drawer, 'CLAIM_RESULT');
    expect(squash(modal.textContent)).not.toMatch(ORIGINAL);
    const [request] = puts(server, 'CLAIM_RESULT');
    expect(queryOf(request!)).toEqual({ variant: 'default' });
    expect(request!.body).toMatchObject({
      sign_name: SIGN,
      template_code: TEMPLATE.fresh,
      template_type: 'notice',
      preview_text: CLAIM_PREVIEW,
      row_version: 0,
    });
    const result = await dialogWith(LATER);
    expect(squash(result.textContent)).toMatch(ACCEPTED);
    expect(squash(result.textContent)).not.toMatch(ORIGINAL);
    await waitFor(() => expect(statusOf('CLAIM_RESULT')).toContain(STATUS.pending));
    expect(rowText('CLAIM_RESULT')).toContain(TEMPLATE.fresh);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#9] 首次登记测试未受理：弹窗写明未受理，不提原配置（D10-339 ④），该行「测试失败」',
  async () => {
    const server = createServer(undefined, { provider: 'rejected' });
    await mount(server);
    const drawer = await openDrawer('CLAIM_RESULT');
    await fill(textbox(drawer, LABEL.sign), SIGN);
    await fill(textbox(drawer, LABEL.template), TEMPLATE.fresh);
    await fill(textbox(drawer, LABEL.preview), CLAIM_PREVIEW);
    await saveWithTest(server, drawer, 'CLAIM_RESULT');
    const result = await dialogWith(REVISE);
    await waitFor(() => expect(squash(result.textContent)).toMatch(NOT_ACCEPTED));
    expect(squash(result.textContent)).not.toMatch(ORIGINAL);
    await waitFor(() => expect(statusOf('CLAIM_RESULT')).toContain(STATUS.failed));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#10] SMS_CODE 登记：模板类型锁定验证码，PUT 带 template_type=verify',
  async () => {
    const { server } = await mount();
    const drawer = await openDrawer('SMS_CODE');
    await fill(textbox(drawer, LABEL.sign), SIGN);
    await fill(textbox(drawer, LABEL.template), TEMPLATE.fresh);
    await fill(textbox(drawer, LABEL.preview), CODE_PREVIEW);
    await saveWithTest(server, drawer, 'SMS_CODE');
    expect(puts(server, 'SMS_CODE')[0]!.body).toMatchObject({
      template_code: TEMPLATE.fresh,
      template_type: 'verify',
      preview_text: CODE_PREVIEW,
      row_version: 0,
    });
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#11] 服务端按字段拒（20001 fields=[preview_text]，reason=notify_preview_vars_mismatch）：只在预览正文旁提示，列表不变',
  async () => {
    const server = createServer();
    server.once('PUT', smsPath('WD_SUCCESS'), () =>
      failure(20001, { fields: ['preview_text'], reason: 'notify_preview_vars_mismatch' }),
    );
    await mount(server);
    const drawer = await openDrawer('WD_SUCCESS');
    // A valid preview (both variables kept): only the server's answer can mark the field.
    await fill(textbox(drawer, LABEL.preview), WD_SUCCESS_EDITED);
    await saveDirect(server, drawer, 'WD_SUCCESS');
    await expectFieldError(textbox(drawer, LABEL.preview));
    expect(fieldError(textbox(drawer, LABEL.sign)), 'no error next to the signature').toBe('');
    expect(fieldError(textbox(drawer, LABEL.template)), 'no error next to the CODE').toBe('');
    expect(server.row('WD_SUCCESS').active?.preview_text).toBe(PREVIEW.wdSuccess);
    expect(rowText('WD_SUCCESS')).toContain(squash(PREVIEW.wdSuccess));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#12] 预览正文少了定义的变量：前端预检拦下（不验证、不发 PUT）或发 PUT 收 20001 均可，都在预览正文旁提示，在用配置不变',
  async () => {
    const { server } = await mount();
    const drawer = await openDrawer('WD_SUCCESS');
    // ${payout_channel_name} is missing.
    await fill(textbox(drawer, LABEL.preview), '【凑狸】提现已到账：${net}，请查收。');
    const sent = await saveExpectingFieldError(server, drawer, textbox(drawer, LABEL.preview));
    if (!sent) expect(server.requests('POST', VERIFY)).toEqual([]);
    await expectFieldError(textbox(drawer, LABEL.preview));
    expect(server.row('WD_SUCCESS').active?.preview_text).toBe(PREVIEW.wdSuccess);
    expect(server.row('WD_SUCCESS').pending).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#13] SMS_CODE 正文写的分钟数与有效期（sms_code_ttl_sec=300）不一致：在预览正文旁提示，不保存',
  async () => {
    const { server } = await mount();
    const drawer = await openDrawer('SMS_CODE');
    await fill(textbox(drawer, LABEL.sign), SIGN);
    await fill(textbox(drawer, LABEL.template), TEMPLATE.fresh);
    await fill(textbox(drawer, LABEL.preview), CODE_PREVIEW_TTL);
    await saveExpectingFieldError(server, drawer, textbox(drawer, LABEL.preview));
    await expectFieldError(textbox(drawer, LABEL.preview));
    expect(server.row('SMS_CODE').pending).toBeNull();
    expect(server.row('SMS_CODE').active).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#14] 预览正文含禁用词（20001 fields=[preview_text, 禁用词]）：预览正文旁的提示里写出禁用词',
  async () => {
    const { server } = await mount();
    const drawer = await openDrawer('WD_SUCCESS');
    await fill(textbox(drawer, LABEL.preview), `${WD_SUCCESS_EDITED}${BANNED_WORD}`);
    await saveExpectingFieldError(server, drawer, textbox(drawer, LABEL.preview));
    await expectFieldError(textbox(drawer, LABEL.preview), BANNED_WORD);
    expect(server.row('WD_SUCCESS').active?.preview_text).toBe(PREVIEW.wdSuccess);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#15] 保存遇 20902：提示并重新拉列表',
  async () => {
    const server = createServer();
    server.once('PUT', smsPath('WD_SUCCESS'), () => {
      server.item('WD_SUCCESS').row_version = 7;
      return failure(20902, undefined, '状态已变化，请刷新后重试');
    });
    await mount(server);
    const drawer = await openDrawer('WD_SUCCESS');
    await fill(textbox(drawer, LABEL.preview), WD_SUCCESS_EDITED);
    await saveDirect(server, drawer, 'WD_SUCCESS');
    await waitFor(() => expect(server.requests('GET', LIST)).toHaveLength(2));
    await waitFor(() => expect(bodyText()).toMatch(CONFLICT));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#16] row_version 取该编码当前值：先开关后保存，PUT 用开关返回的 row_version，并各自验证动态码',
  async () => {
    const { server } = await mount();
    await openChannels('WD_SUCCESS');
    await click(toggle('push', 'WD_SUCCESS'));
    await verify(await stepUpDialog());
    const patches = () => server.requests('PATCH', channelPath('WD_SUCCESS'));
    await waitFor(() => expect(patches()).toHaveLength(1));
    await settled(server);
    await waitFor(() =>
      expect(toggle('push', 'WD_SUCCESS').getAttribute('aria-checked')).toBe('false'),
    );
    const drawer = await openDrawer('WD_SUCCESS');
    await fill(textbox(drawer, LABEL.preview), WD_SUCCESS_EDITED);
    await saveDirect(server, drawer, 'WD_SUCCESS');
    const put = puts(server, 'WD_SUCCESS')[0]!;
    expect(put.body).toMatchObject({ row_version: 3 });
    assertWrite(put, 'test-totp-2');
    assertVerified(server, 2);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#17] 抽屉里取消动态码：不验证、不保存',
  async () => {
    const { server } = await mount();
    const drawer = await openDrawer('WD_SUCCESS');
    await fill(textbox(drawer, LABEL.preview), WD_SUCCESS_EDITED);
    await click(action(drawer, SAVE));
    await cancelStepUp(await stepUpDialog());
    await waitFor(() => expect(stepUpOpen()).toBe(false));
    await settled(server);
    expect(server.requests('POST', VERIFY)).toEqual([]);
    expect(server.writes()).toEqual([]);
    activeKept(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-EDIT#18] 「待测试」登记已受理时编辑抽屉另给【启用新配置】：动态码 → POST …/sms/pending/enable，该行「已启用」新模板 CODE',
  async () => {
    const { server } = await mount();
    const drawer = await openDrawer('UNION_AUTH_EXPIRING');
    const enable = usable(drawer, ENABLE);
    expect(enable, '【启用新配置】 in the drawer').toHaveLength(1);
    await click(enable[0]!);
    const verification = await stepUpDialog();
    expect(server.writes()).toEqual([]);
    await verify(verification);
    await waitFor(() => expect(enables(server, 'UNION_AUTH_EXPIRING')).toHaveLength(1));
    const [request] = enables(server, 'UNION_AUTH_EXPIRING');
    expect(queryOf(request!)).toEqual({ variant: 'default' });
    expect(request!.body).toEqual({ row_version: 3 });
    assertWrite(request!, 'test-totp-1');
    await settled(server);
    await waitFor(() => expect(statusOf('UNION_AUTH_EXPIRING')).toContain(STATUS.enabled));
    expect(rowText('UNION_AUTH_EXPIRING')).toContain(TEMPLATE.unionPending);
    expect(rowText('UNION_AUTH_EXPIRING')).not.toContain(TEMPLATE.unionActive);
  },
  FLOW_TIMEOUT,
);

it.each([
  {
    name: 'WD_FAILED（测试失败）',
    code: 'WD_FAILED',
    variant: 'default',
    shown: ['amount'],
    absent: [],
  },
  {
    // amount belongs to WD_REJECTED's default variant only.
    name: 'WD_REJECTED · negative_balance（未发送）',
    code: 'WD_REJECTED',
    variant: 'negative_balance',
    shown: ['reason'],
    absent: ['amount'],
  },
] satisfies {
  name: string;
  code: string;
  variant: string;
  shown: string[];
  absent: string[];
}[])(
  '[AC-F1-06zv-EDIT#19] $name：测试未受理或未发送的「待测试」登记，抽屉不给【启用新配置】；只列该变体定义的变量',
  async ({ code, variant, shown, absent }) => {
    await mount();
    const drawer = await openDrawer(code, variant);
    for (const name of shown) expect(shows(drawer, name), `variable ${name}`).toBe(true);
    for (const name of absent) expect(shows(drawer, name), `no variable ${name}`).toBe(false);
    expect(usable(drawer, ENABLE)).toEqual([]);
  },
  FLOW_TIMEOUT,
);
