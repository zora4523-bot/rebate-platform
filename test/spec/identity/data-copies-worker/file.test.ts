// B1-27h（08 BR-ID-40 细则「交付（默认）」「企业微信会话交付的下载」；brief §9 ③）：副本文件，不连库。
// - in_app_sms 的文件是标准 ZIP，每个条目都是 WinZip AES-256 加密、口令为提取码；用 kit 里独立的读取器
//   （不用被测代码自己的解密）解开，内容原样；错口令解不开。
// - 提取码 / 口令来自 CSPRNG（Math.random 被固定也照样每次不同），能当口令解开文件；长度与字符集 08 与
//   契约都没定（短信模板可能限制变量格式），这里不钉。
// - wecom_session 的文件用服务端字段密钥封存，同一密钥打开得原样条目，另一把密钥打不开。
// - 文件条目覆盖导出范围的每一节，bigint 分与时刻都能序列化；条目名不带个人信息。
import { randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  NICKNAME,
  PHONE,
  content,
  digest,
  entriesText,
  expectedValues,
  fieldCrypto,
  identity,
  isAes256,
  marks,
  openAesZip,
  zipFileEntries,
} from './kit.ts';

const PASSWORD = 'synthetic-copy-password';
const WRONG = 'synthetic-other-password';

function sample() {
  return [
    {
      name: 'account.json',
      bytes: new TextEncoder().encode(`{"phone":"${PHONE}","nickname":"${NICKNAME}"}`),
    },
    { name: 'binary.bin', bytes: new Uint8Array(randomBytes(5000)) },
    { name: 'empty.txt', bytes: new Uint8Array() },
  ];
}

it('[AC-B1-27h#1] encryptDataCopyZip：标准 ZIP、每个条目 WinZip AES-256 加密；独立读取器用口令原样解开，错口令解不开；明文不出现在文件里；同样输入每次加密结果不同', async () => {
  const api = await identity();
  const entries = sample();
  const zip = api.encryptDataCopyZip(entries, PASSWORD);
  expect(zip).toBeInstanceOf(Uint8Array);
  const info = zipFileEntries(zip);
  expect(info.map((entry) => entry.name).sort()).toEqual(entries.map((entry) => entry.name).sort());
  for (const entry of info) expect(isAes256(entry), entry.name).toBe(true);
  expect(digest(openAesZip(zip, PASSWORD))).toEqual(digest(entries));
  expect(() => openAesZip(zip, WRONG)).toThrow();
  expect(Buffer.from(zip).includes(PHONE)).toBe(false);
  expect(Buffer.from(zip).includes(NICKNAME)).toBe(false);
  const again = api.encryptDataCopyZip(entries, PASSWORD);
  expect(Buffer.from(again).equals(Buffer.from(zip))).toBe(false);
  expect(digest(openAesZip(again, PASSWORD))).toEqual(digest(entries));
});

it('[AC-B1-27h#2] generateDataCopySecret：非空字符串，每次不同（200 次几乎不重复）；来自 CSPRNG，不读 Math.random；拿它当口令加密的文件用它解得开', async () => {
  const api = await identity();
  const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
  try {
    const secrets = Array.from({ length: 200 }, () => api.generateDataCopySecret());
    for (const secret of secrets) {
      expect(typeof secret).toBe('string');
      expect(secret.length).toBeGreaterThan(0);
    }
    // The format is not fixed: a short code may collide by chance, a fixed or few-valued one may not.
    expect(new Set(secrets).size).toBeGreaterThanOrEqual(190);
    expect(random).not.toHaveBeenCalled();
  } finally {
    random.mockRestore();
  }
  const secret = api.generateDataCopySecret();
  const entries = sample();
  expect(digest(openAesZip(api.encryptDataCopyZip(entries, secret), secret))).toEqual(
    digest(entries),
  );
});

it('[AC-B1-27h#3] 服务端封存（wecom_session）：同一字段密钥打开得原样条目，另一把密钥打不开；封存结果不含明文', async () => {
  const api = await identity();
  const crypto = await fieldCrypto();
  const other = await fieldCrypto();
  const m = marks();
  const entries = api.dataCopyFileEntries(content(m));
  const sealed = api.sealDataCopyEntries(entries, crypto);
  expect(sealed).toBeInstanceOf(Uint8Array);
  for (const value of [PHONE, NICKNAME, m.order, m.agent]) {
    expect(Buffer.from(sealed).includes(value), value).toBe(false);
  }
  expect(digest(api.openSealedDataCopyEntries(sealed, crypto))).toEqual(digest(entries));
  expect(() => api.openSealedDataCopyEntries(sealed, other)).toThrow();
  // Each sealing is fresh (random IV), and still opens to the same entries.
  const again = api.sealDataCopyEntries(entries, crypto);
  expect(Buffer.from(again).equals(Buffer.from(sealed))).toBe(false);
  expect(digest(api.openSealedDataCopyEntries(again, crypto))).toEqual(digest(entries));
});

it('[AC-B1-27h#4] 文件条目：导出范围每一节都在（账号资料、实名脱敏、同意记录、订单、余额流水、提现记录脱敏、Agent 对话），bigint 分与时刻可序列化；条目名不重复、不带路径穿越与个人信息', async () => {
  const api = await identity();
  const m = marks();
  const entries = api.dataCopyFileEntries(content(m));
  expect(entries.length).toBeGreaterThan(0);
  const names = entries.map((entry) => entry.name);
  expect(new Set(names).size).toBe(names.length);
  for (const name of names) {
    expect(name).not.toBe('');
    expect(name).not.toMatch(/^[/\\]|\.\.|\\/);
    expect(name).not.toContain(PHONE);
    expect(name).not.toContain(NICKNAME);
  }
  const all = entriesText(entries);
  for (const value of expectedValues(m)) expect(all, value).toContain(value);
  // Amounts in fen (12345 / -1234) or the same amount in yuan; instants with their year.
  expect(all).toMatch(/12345|123\.45/);
  expect(all).toMatch(/-1234|-12\.34/);
  expect(all).toMatch(/2026/);
});
