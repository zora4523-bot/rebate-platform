// @vitest-environment jsdom
// The 「导出完整手机号」 choice is optional (the page may offer it or not); when offered it is only
// there with pii.reveal_phone, needs a reason and a totp step-up, and never leaks into a masked
// export. A page that offers no such choice passes the full-number cases with masked exports only.
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  EXPORTS,
  OTP,
  REASON,
  REASON_MAX,
  createServer,
  failure,
  type Server,
} from './export-fixtures.ts';
import {
  EXPORTER,
  EXPORTER_PII,
  FLOW_TIMEOUT,
  HINT,
  REASON_RULE,
  announceSuccess,
  before,
  click,
  confirmations,
  expectMasked,
  expectNoSuccess,
  expectUnmasked,
  exportMasked,
  fill,
  filterRisk,
  isDisabled,
  mount,
  passOf,
  pressExport,
  reasonHint,
  reasonInput,
  reasonScope,
  ruleText,
  sendUnmasked,
  settle,
  settled,
  stepUp,
  stepUpDialogs,
  submitOf,
  submitter,
  tickUnmasked,
  unmaskOptions,
  untickUnmasked,
  verify,
} from './export-helpers.ts';

/** No full-number choice offered: whatever went out was masked with `filters`, no step-up. */
async function expectOnlyMasked(
  server: Server,
  filters: Readonly<Record<string, string>>,
): Promise<void> {
  await settled(server);
  for (const post of server.exportPosts()) expectMasked(post, filters);
  expect(server.verifies(), 'no step-up without the full-number choice').toEqual([]);
  expect(stepUpDialogs()).toEqual([]);
  expect(server.tasks.every((task) => task.masked)).toBe(true);
}

/** The full-number export with a reason the page must refuse (`value`). */
async function refuse(value: string): Promise<void> {
  const server = createServer({ exports: true, stepUp: true });
  await mount(server, EXPORTER_PII);
  if (!(await tickUnmasked(server))) {
    await expectOnlyMasked(server, {});
    return;
  }
  const input = await reasonInput(server);
  // Taken before typing: a hint shown while typing counts as well as one shown on submit.
  const prior = before();
  await fill(input, value);
  // An input that refuses the 201st character already keeps the reason within the limit.
  if (value.length > REASON_MAX && (await reasonInput(server)).value.length <= REASON_MAX) {
    expect(server.exportPosts()).toEqual([]);
    return;
  }
  const submit = await submitter();
  if (isDisabled(submit)) {
    // A submit held disabled stops the export; the page then states the rule in words.
    expect(ruleText(reasonScope()), 'the reason rule is stated').toMatch(REASON_RULE);
    await click(submit);
    await settle();
    expect(stepUpDialogs()).toEqual([]);
    expect(server.exportPosts(), 'a disabled submit sends nothing').toEqual([]);
  } else {
    await click(submit);
    await settle();
    const sent = stepUpDialogs().length > 0;
    if (sent) {
      await verify(server);
      await waitFor(() => expect(server.exportPosts()).toHaveLength(1));
      await settled(server);
      expect(server.exportPosts()[0]!.body, 'sent as a full-number export').toMatchObject({
        resource: 'users',
        unmasked: true,
      });
    } else {
      expect(server.exportPosts(), 'stopped before sending').toEqual([]);
    }
    // Stopped before sending: a hint beside the reason or a new notice; refused with 20001
    // [reason]: a hint beside the reason. Either way it states the rule.
    await waitFor(() =>
      expect(reasonHint(prior, !sent), 'a hint about the reason').toMatch(HINT.reason),
    );
  }
  expectNoSuccess(prior);
  expect(server.tasks, 'no task created').toEqual([]);
}

it(
  '[AC-F1-07je-UNMASK#1] 不持 pii.reveal_phone（export + user.list）：页面与导出对话框里都没有「导出完整手机号」类选项，导出只发脱敏 body、不弹动态码',
  async () => {
    const server = createServer({ exports: true });
    await mount(server, EXPORTER);
    expect(unmaskOptions(), 'no full-number choice on the page').toEqual([]);
    let prior = before();
    const layer = await pressExport(server);
    expect(unmaskOptions(), 'no full-number choice in the export dialog').toEqual([]);
    if (layer !== undefined) {
      prior = before();
      await click(submitOf(layer));
    }
    await waitFor(() => expect(server.exportPosts()).toHaveLength(1));
    expectMasked(server.exportPosts()[0]!, {});
    await settled(server);
    expect(server.verifies()).toEqual([]);
    expect(stepUpDialogs()).toEqual([]);
    await announceSuccess(prior);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07je-UNMASK#2] 持 pii.reveal_phone 且页面提供完整手机号选项：默认不勾选；勾选并填原因 → 确认 → 动态码（之前不发）→ 一次 POST，body 为 {resource, filters: {risk_state: banned}, unmasked: true, reason}，header 带新令牌、无 Idempotency-Key；202 后提示已创建并指向导出记录',
  async () => {
    const server = createServer({ exports: true, stepUp: true });
    await mount(server, EXPORTER_PII);
    await filterRisk(server, 'banned');
    if (!(await tickUnmasked(server))) {
      await expectOnlyMasked(server, { risk_state: 'banned' });
      return;
    }
    const { post, prior } = await sendUnmasked(server, REASON);
    expectUnmasked(server, post, { risk_state: 'banned' }, REASON);
    expect(passOf(post)).toBe(server.issued[0]);
    expect(server.verifies().map((one) => one.body)).toEqual([{ tier: 'totp', code: OTP }]);
    expect(server.exportPosts()).toHaveLength(1);
    expect(
      server.tasks.map((task) => task.masked),
      'a full-number task',
    ).toEqual([false]);
    await announceSuccess(prior);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07je-UNMASK#3] 勾选完整手机号但原因为空：前端拦下并说明规则，或发出后收 20001 [reason] 在原因旁说明；不提示已创建',
  async () => {
    await refuse('');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07je-UNMASK#4] 勾选完整手机号但原因超过 200 字：前端拦下（或输入框不收第 201 个字）并说明规则，或发出后收 20001 [reason] 在原因旁说明；不提示已创建',
  async () => {
    await refuse('核'.repeat(REASON_MAX + 1));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07je-UNMASK#5] 完整手机号导出回 10003：重新弹动态码，验证后用新令牌、同样的 body 再发一次，之后提示已创建',
  async () => {
    const server = createServer({ exports: true, stepUp: true });
    server.once('POST', EXPORTS, () => failure(10003, { tier: 'totp' }));
    await mount(server, EXPORTER_PII);
    if (!(await tickUnmasked(server))) {
      await expectOnlyMasked(server, {});
      return;
    }
    const first = await sendUnmasked(server, REASON);
    await stepUp();
    await settled(server);
    expect(server.exportPosts()).toHaveLength(1);
    expect(server.verifies()).toHaveLength(1);
    expectNoSuccess(first.prior);
    await verify(server);
    await waitFor(() => expect(server.exportPosts()).toHaveLength(2));
    await settled(server);
    const posts = server.exportPosts();
    expect(posts.map((one) => passOf(one))).toEqual([server.issued[0], server.issued[1]]);
    for (const post of posts) expectUnmasked(server, post, {}, REASON);
    expect(server.tasks.map((task) => task.masked)).toEqual([false]);
    await announceSuccess(first.prior);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07je-UNMASK#6] 勾选后又取消勾选：导出回到脱敏，body 不带 unmasked / reason，不带令牌，不弹动态码',
  async () => {
    const server = createServer({ exports: true, stepUp: true });
    await mount(server, EXPORTER_PII);
    if (!(await tickUnmasked(server))) {
      await expectOnlyMasked(server, {});
      return;
    }
    await untickUnmasked();
    const layers = confirmations();
    let prior = before();
    if (layers.length === 1) {
      await click(submitOf(layers[0]!));
      await waitFor(() => expect(server.exportPosts()).toHaveLength(1));
    } else {
      prior = (await exportMasked(server)).prior;
    }
    await settled(server);
    expect(server.exportPosts()).toHaveLength(1);
    expectMasked(server.exportPosts()[0]!, {});
    expect(server.verifies(), 'no step-up once unticked').toEqual([]);
    expect(stepUpDialogs()).toEqual([]);
    expect(server.tasks.map((task) => task.masked)).toEqual([true]);
    await announceSuccess(prior);
  },
  FLOW_TIMEOUT,
);
