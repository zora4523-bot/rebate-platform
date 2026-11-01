// B2-15k 交易账单（claude-independent，SPEC_REF deb521c2）：任务书 9.7：先核 appId；下载并校验；两家文档都没给可靠的文件
// 格式，解析不写：下载成功也返回 unknown / bill_format_unverified，下载或校验失败是别的固定 reason。
// 出处：docs-mirror/wechat-pay/pages/4013071227.txt（申请账单）、4013071238.txt:133（下载不验签）、4013053249.txt:81-85；
// docs-mirror/alipay/app-pay/02e7gr.md（示例地址是 http，所以这里不限制支付宝地址的协议）、00dn7a.md。未实测（BR-PAY-09）。
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { PayHttpRequest } from '../../../../apps/api/src/modules/payment/infra/channels/transport.ts';
import {
  BILL_NODE,
  MCHID,
  PAY_APP_ID,
  aliAnswer,
  aliBiz,
  aliEnvelopeFaults,
  aliError,
  aliMethod,
  aliParams,
  alipayChannel,
  expectAliSigned,
  expectUnknown,
  expectWxSigned,
  headerOf,
  rawAnswer,
  wechatChannel,
  without,
  wxAnswer,
  wxEnvelopeFaults,
  type Json,
} from './kit.ts';

const DATE = '2026-10-31';
const FILE = 'synthetic,bill,text\n1,2,3\n';
const DOWNLOAD = 'https://api.mch.weixin.qq.com/v3/billdownload/file?token=synthetic';

function sha1(text: string | Uint8Array): string {
  return createHash('sha1').update(text).digest('hex');
}

function wxBillAnswer(overrides: Json = {}): Json {
  return { hash_type: 'SHA1', hash_value: sha1(FILE), download_url: DOWNLOAD, ...overrides };
}

function isDownload(request: PayHttpRequest): boolean {
  return request.url.includes('/v3/billdownload/');
}

function wxBillRoute(apply = wxAnswer(200, wxBillAnswer()), file = rawAnswer(FILE)) {
  return (request: PayHttpRequest) => (isDownload(request) ? file : apply);
}

it('[AC-B2-15k#1201] 微信 appId 不是配置的 PAY_APP_ID：unknown，不发请求（不下别的应用的账单）', async () => {
  const h = wechatChannel(wxBillRoute());
  expectUnknown(await h.channel.downloadBill(DATE, 'other-app'));
  expect(h.calls).toHaveLength(0);
});

it('[AC-B2-15k#1202] 微信申请账单：GET /v3/bill/tradebill 带 bill_date，APIv3 签名；再按 V3 规则签名去下载地址取文件', async () => {
  const h = wechatChannel(wxBillRoute());
  await h.channel.downloadBill(DATE, PAY_APP_ID);
  expect(h.calls).toHaveLength(2);
  const apply = h.calls[0]!;
  expect(apply.method).toBe('GET');
  const url = new URL(apply.url);
  expect(`${url.origin}${url.pathname}`).toBe('https://api.mch.weixin.qq.com/v3/bill/tradebill');
  expect(url.searchParams.get('bill_date')).toBe(DATE);
  expectWxSigned(apply);
  const download = h.calls[1]!;
  expect(download.method).toBe('GET');
  expect(download.url).toBe(DOWNLOAD);
  expect(headerOf(download, 'authorization')).toContain(`mchid="${MCHID}"`);
  expectWxSigned(download);
});

it('[AC-B2-15k#1203] 微信下载成功且 SHA1 相符（文件响应不带签名头，文档说不验签）：解析不写，返回 unknown / bill_format_unverified', async () => {
  const h = wechatChannel(wxBillRoute());
  expect(await h.channel.downloadBill(DATE, PAY_APP_ID)).toEqual({
    kind: 'unknown',
    reason: 'bill_format_unverified',
  });
});

it('[AC-B2-15k#1204] 微信 SHA1 按字节算：transport 给了 bytes 时以 bytes 为准', async () => {
  const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
  const h = wechatChannel(
    wxBillRoute(wxAnswer(200, wxBillAnswer({ hash_value: sha1(bytes) })), {
      status: 200,
      headers: {},
      body: bytes.toString('utf8'),
      bytes,
    }),
  );
  expect(await h.channel.downloadBill(DATE, PAY_APP_ID)).toEqual({
    kind: 'unknown',
    reason: 'bill_format_unverified',
  });
});

const WX_FILE_FAULTS: [string, ReturnType<typeof rawAnswer>][] = [
  ['SHA1 不符', rawAnswer(`${FILE}tampered`)],
  ['下载 HTTP 500', rawAnswer(FILE, 500)],
  ['下载 HTTP 302', rawAnswer(FILE, 302)],
];

it.each(WX_FILE_FAULTS)(
  '[AC-B2-15k#1205] 微信下载或校验失败（%s）：unknown，reason 不是 bill_format_unverified',
  async (_name, file) => {
    const h = wechatChannel(wxBillRoute(wxAnswer(200, wxBillAnswer()), file));
    const result = await h.channel.downloadBill(DATE, PAY_APP_ID);
    expectUnknown(result);
    expect(result.kind === 'unknown' ? result.reason : '').not.toBe('bill_format_unverified');
  },
);

it('[AC-B2-15k#1206] 微信下载 transport 抛异常：unknown，不抛', async () => {
  const h = wechatChannel((request) => {
    if (isDownload(request)) throw new Error('boom');
    return wxAnswer(200, wxBillAnswer());
  });
  const result = await h.channel.downloadBill(DATE, PAY_APP_ID);
  expectUnknown(result);
  expect(result.kind === 'unknown' ? result.reason : '').not.toBe('bill_format_unverified');
});

it.each(wxEnvelopeFaults(JSON.stringify(wxBillAnswer())))(
  '[AC-B2-15k#1207] 微信申请账单应答不可信（%s）：unknown，不下载',
  async (_name, answer) => {
    const h = wechatChannel(wxBillRoute(answer));
    const result = await h.channel.downloadBill(DATE, PAY_APP_ID);
    expectUnknown(result);
    expect(h.calls).toHaveLength(1);
  },
);

const WX_BAD_ANSWERS: [string, Json][] = [
  ['hash_type 不是 SHA1', wxBillAnswer({ hash_type: 'MD5' })],
  ['缺 hash_value', without(wxBillAnswer(), 'hash_value')],
  ['缺 download_url', without(wxBillAnswer(), 'download_url')],
  ['download_url 是数字', wxBillAnswer({ download_url: 42 })],
  [
    'download_url 不是 https',
    wxBillAnswer({ download_url: 'http://api.mch.weixin.qq.com/v3/billdownload/file' }),
  ],
];

it.each(WX_BAD_ANSWERS)(
  '[AC-B2-15k#1208] 微信申请账单 200 验签通过但内容不对（%s）：unknown，不下载',
  async (_name, body) => {
    const h = wechatChannel(wxBillRoute(wxAnswer(200, body)));
    const result = await h.channel.downloadBill(DATE, PAY_APP_ID);
    expectUnknown(result);
    expect(result.kind === 'unknown' ? result.reason : '').not.toBe('bill_format_unverified');
    expect(h.calls).toHaveLength(1);
  },
);

it.each([
  [400, 'NO_STATEMENT_EXIST'],
  [400, 'STATEMENT_CREATING'],
  [429, 'FREQUENCY_LIMITED'],
])(
  '[AC-B2-15k#1209] 微信账单错误 %s %s：unknown，reason 不是 bill_format_unverified',
  async (status, code) => {
    const h = wechatChannel(wxBillRoute(wxAnswer(status, { code })));
    const result = await h.channel.downloadBill(DATE, PAY_APP_ID);
    expectUnknown(result);
    expect(result.kind === 'unknown' ? result.reason : '').not.toBe('bill_format_unverified');
  },
);

// ---- 支付宝

const ALI_URL = 'http://dwbillcenter.example.test/downloadBillFile.resource?fileId=synthetic';
const ALI_NODE: Json = { code: '10000', msg: 'Success', bill_download_url: ALI_URL };

function aliBillRoute(apply = aliAnswer(BILL_NODE, ALI_NODE), file = rawAnswer(FILE)) {
  return (request: PayHttpRequest) => (request.url === ALI_URL ? file : apply);
}

it('[AC-B2-15k#1220] 支付宝 appId 不是配置的 PAY_APP_ID：unknown，不发请求', async () => {
  const h = alipayChannel(aliBillRoute());
  expectUnknown(await h.channel.downloadBill(DATE, 'other-app'));
  expect(h.calls).toHaveLength(0);
});

it('[AC-B2-15k#1221] 支付宝：alipay.data.dataservice.bill.downloadurl.query，bill_type=trade、bill_date，RSA2 签名；取 bill_download_url 并下载', async () => {
  const h = alipayChannel(aliBillRoute());
  await h.channel.downloadBill(DATE, PAY_APP_ID);
  expect(h.calls).toHaveLength(2);
  expect(aliMethod(h.calls[0]!)).toBe('alipay.data.dataservice.bill.downloadurl.query');
  expect(aliBiz(h.calls[0]!)).toEqual({ bill_type: 'trade', bill_date: DATE });
  expectAliSigned(aliParams(h.calls[0]!));
  expect(h.calls[1]!.method).toBe('GET');
  expect(h.calls[1]!.url).toBe(ALI_URL);
});

it('[AC-B2-15k#1222] 支付宝下载成功：解析不写，返回 unknown / bill_format_unverified', async () => {
  const h = alipayChannel(aliBillRoute());
  expect(await h.channel.downloadBill(DATE, PAY_APP_ID)).toEqual({
    kind: 'unknown',
    reason: 'bill_format_unverified',
  });
});

it('[AC-B2-15k#1223] 支付宝下载 HTTP 非 200：unknown，reason 不是 bill_format_unverified', async () => {
  const h = alipayChannel(aliBillRoute(aliAnswer(BILL_NODE, ALI_NODE), rawAnswer(FILE, 500)));
  const result = await h.channel.downloadBill(DATE, PAY_APP_ID);
  expectUnknown(result);
  expect(result.kind === 'unknown' ? result.reason : '').not.toBe('bill_format_unverified');
});

it.each(aliEnvelopeFaults(BILL_NODE, ALI_NODE))(
  '[AC-B2-15k#1224] 支付宝账单应答外壳不可信（%s）：unknown，不下载',
  async (_name, answer) => {
    const h = alipayChannel(aliBillRoute(answer));
    expectUnknown(await h.channel.downloadBill(DATE, PAY_APP_ID));
    expect(h.calls).toHaveLength(1);
  },
);

const ALI_BAD_NODES: [string, Json][] = [
  ['缺 bill_download_url（文档：账单可获取时才返回）', { code: '10000', msg: 'Success' }],
  [
    'bill_download_url 是对象',
    { code: '10000', msg: 'Success', bill_download_url: { value: ALI_URL } },
  ],
  ['bill_download_url 不是地址', { code: '10000', msg: 'Success', bill_download_url: 'not a url' }],
  ['业务错误 BILL_NOT_EXIST', aliError('40004', 'BILL_NOT_EXIST')],
  ['业务错误 TYPE_NOT_SUPPORTED', aliError('40004', 'TYPE_NOT_SUPPORTED')],
];

it.each(ALI_BAD_NODES)(
  '[AC-B2-15k#1225] 支付宝账单内容不对（%s）：unknown，reason 不是 bill_format_unverified，不下载',
  async (_name, node) => {
    const h = alipayChannel(aliBillRoute(aliAnswer(BILL_NODE, node)));
    const result = await h.channel.downloadBill(DATE, PAY_APP_ID);
    expectUnknown(result);
    expect(result.kind === 'unknown' ? result.reason : '').not.toBe('bill_format_unverified');
    expect(h.calls).toHaveLength(1);
  },
);
