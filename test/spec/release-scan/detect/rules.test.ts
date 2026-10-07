import { createPropStats, propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import type { DetectRuleId, ScanHit } from '../../../../infra/release-scan/detect/index.ts';
import { detectSecrets } from '../../../../infra/release-scan/detect/index.ts';
import { FAKE, HEX16, NEVER, pem, pemBlock, sorted, spread, want } from './fixtures.ts';

// 02 §12.6 发布制品密钥扫描：规则 = 私钥头 + 上表各密钥的格式特征 + 高熵串，规则里不写密钥值；
// 服务端密钥、私钥与 BR-ID-09 禁止内置的请求签名材料、共享盐不可豁免（命中标 never_accepted）。
// 口径（字段名关键词，大小写与 _ - 不计）：签名材料 = install_secret、sign + key/secret、hmac、salt；
// 服务端密钥 = secret、password、passwd、private_key、apiv3；其余含 key、token、credential 的为 keyed-credential。
// 服务端密钥与 keyed-credential 的取值：紧跟分隔符（可带引号）、≥16 位 [A-Za-z0-9+/=_-] 且至少含一个数字，
// 命中原文只取值本身。签名材料字段另按更严的口径（≥8 位、不要求数字、可含标点、UTF-16），见 sign-material.test.ts。

const SIGN_NAMES = ['install_secret', 'installSecret', 'INSTALL_SECRET', 'signKey', 'sign_secret'];
const SIGN_NAMES_2 = ['signingKey', 'hmacKey', 'hmac_secret', 'shared_salt', 'signSalt', 'salt'];
const SERVER_NAMES = ['appSecret', 'app_secret', 'AppSecret', 'client_secret', 'clientSecret'];
const SERVER_NAMES_2 = ['apiV3Key', 'api_v3_key', 'accessKeySecret', 'password', 'db_passwd'];
const SERVER_NAMES_3 = ['privateKey', 'MASTER_SECRET'];
const KEYED_NAMES = ['appKey', 'app_key', 'apiKey', 'API_KEY', 'accessToken', 'refresh_token'];
const KEYED_NAMES_2 = ['uploadToken', 'credential'];
const TABLE: ReadonlyArray<readonly [DetectRuleId, readonly string[]]> = [
  ['request-sign-material', [...SIGN_NAMES, ...SIGN_NAMES_2]],
  ['server-secret', [...SERVER_NAMES, ...SERVER_NAMES_2, ...SERVER_NAMES_3]],
  ['keyed-credential', [...KEYED_NAMES, ...KEYED_NAMES_2]],
];
const FILE = 'assets/main.js';
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

it('[02 §12.6 私钥头#1] 各类 PEM 私钥块各报一条 private-key（不可豁免），命中从头一行起，正文不另报', () => {
  const labels = ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'DSA PRIVATE KEY'];
  for (const label of [
    ...labels,
    'OPENSSH PRIVATE KEY',
    'ENCRYPTED PRIVATE KEY',
    'PGP PRIVATE KEY BLOCK',
  ]) {
    const hits = detectSecrets('assets/k.pem', `# a\n# b\n${pemBlock(label)}\n`);
    expect(hits, label).toHaveLength(1);
    expect(hits[0], label).toMatchObject({
      rule: 'private-key',
      file: 'assets/k.pem',
      line: 3,
      never_accepted: true,
    });
    expect(hits[0]?.match.startsWith(pem('BEGIN', label)), label).toBe(true);
  }
});

it('[02 §12.6 私钥头#2] 私钥头嵌在压缩 JS 的字符串里（\\n 转义）、小写、缺 footer、在二进制里都要命中', () => {
  const header = pem('BEGIN', 'PRIVATE KEY');
  const inline = `var k="${header}\\n${FAKE.pemBody}\\n${pem('END', 'PRIVATE KEY')}";`;
  const cases: Array<[string, string | Uint8Array, number, string]> = [
    ['inline', `x();${inline}`, 1, header],
    ['lower', `\n${header.toLowerCase()}\n${FAKE.pemBody}\n`, 2, header.toLowerCase()],
    ['no-footer', `${header}\n${FAKE.pemBody}\n`, 1, header],
    [
      'binary',
      Buffer.concat([Buffer.from([0, 0xff, 0x0a, 0]), Buffer.from(header), Buffer.from([0, 0xfe])]),
      2,
      header,
    ],
  ];
  for (const [label, content, line, head] of cases) {
    const hits = detectSecrets('lib/x', content);
    expect(hits, label).toHaveLength(1);
    expect(hits[0], label).toMatchObject({ rule: 'private-key', line, never_accepted: true });
    expect(hits[0]?.match.startsWith(head), label).toBe(true);
  }
});

it('[BR-ID-09][02 §12.6 格式特征#1] 签名材料、服务端密钥与带 key/token 的字段：低熵 32/40 位十六进制也按规则命中，只取值', () => {
  for (const [rule, names] of TABLE) {
    for (const name of names) {
      for (const value of [FAKE.hex32Low, FAKE.hex40Low, spread(16, 24)]) {
        const hits = detectSecrets(FILE, `// x\nconst c = { ${name}: "${value}" };\n`);
        expect(hits, `${name} ${value}`).toEqual([want(rule, FILE, 2, value)]);
      }
    }
  }
});

it('[02 §12.6 格式特征#2] Android 资源、meta-data、plist、properties、JSON 写法都识别字段名', () => {
  const v = FAKE.hex32Low;
  const cases: Array<[string, string, number]> = [
    [
      'res/values/strings.xml',
      `<resources>\n<string name="wechat_app_secret">${v}</string>\n</resources>`,
      2,
    ],
    ['AndroidManifest.xml', `<meta-data android:name="PUSH_APP_SECRET" android:value="${v}"/>`, 1],
    [
      'Payload/Demo.app/Info.plist',
      `<dict>\n<key>AppSecret</key>\n\t<string>${v}</string>\n</dict>`,
      3,
    ],
    ['assets/app.properties', `# c\nAPP_SECRET=${v}\n`, 2],
    ['assets/conf.json', `{"name":"demo","app_secret":"${v}"}`, 1],
  ];
  for (const [file, content, line] of cases) {
    expect(detectSecrets(file, content), file).toEqual([want('server-secret', file, line, v)]);
  }
});

it('[02 §12.6 格式特征#3] 不足 16 位、没有数字的取值和普通代码不报（关键词规则不放大误报）', () => {
  const letters = LETTERS.slice(0, 20);
  const contents = [
    `const c = { password: "${letters}" };`,
    `const c = { appSecret: "${spread(15, 15)}" };`,
    'function add(a, b) { return a + b; } fetch("https://api.example.test/v1/products");',
  ];
  for (const content of contents) expect(detectSecrets(FILE, content), content).toEqual([]);
});

it('[02 §12.6 格式特征#4] 阿里云短信 AccessKey ID 形状单独出现或在 key 字段里都按 aliyun-access-key 报（不可豁免）', () => {
  for (const id of [FAKE.akId, FAKE.akIdShort]) {
    expect(detectSecrets(FILE, `f("${id}");`)).toEqual([want('aliyun-access-key', FILE, 1, id)]);
    expect(detectSecrets(FILE, `{ AccessKeyId: "${id}" }`)).toEqual([
      want('aliyun-access-key', FILE, 1, id),
    ]);
  }
});

it('[02 §12.6 格式特征#5] URL 里带口令（数据库、Redis、旧式 DSN）整段按 credential-url 报；只有用户名不报', () => {
  const urls = [
    `postgres://app_user:${FAKE.password}@db.example.test:5432/app`,
    `redis://:${FAKE.password}@cache.example.test:6379/0`,
    `https://${FAKE.hex32High}:${FAKE.hex32High}@o1.ingest.example.test/42`,
  ];
  for (const url of urls) {
    expect(detectSecrets(FILE, `\nconnect("${url}");`), url).toEqual([
      want('credential-url', FILE, 2, url),
    ]);
  }
  expect(detectSecrets(FILE, 'open("https://demo@api.example.test/v1");')).toEqual([]);
});

it('[02 §12.6 去重#1] 同一段只报一次：不可豁免规则优先于 key 字段与高熵', () => {
  const high = spread(24, 24);
  expect(detectSecrets(FILE, `{ appSecret: "${high}" }`)).toEqual([
    want('server-secret', FILE, 1, high),
  ]);
  expect(detectSecrets(FILE, `{ installSecret: "${FAKE.hex32High}" }`)).toEqual([
    want('request-sign-material', FILE, 1, FAKE.hex32High),
  ]);
  expect(detectSecrets(FILE, `{ appKey: "${high}" }`)).toEqual([
    want('keyed-credential', FILE, 1, high),
  ]);
});

it('[02 §12.6 公开标识#1] 高熵串在 URL 里时整段 URL 作命中原文（交比对段按 DSN / 服务地址判定）', () => {
  const hook = `https://hooks.example.test/services/${spread(30, 30)}`;
  for (const url of [FAKE.dsn, hook]) {
    expect(detectSecrets(FILE, `init({dsn:"${url}"});`), url).toEqual([
      want('high-entropy', FILE, 1, url),
    ]);
  }
});

it('[02 §12.6 公开标识#2] PEM 公钥块里的高熵正文并为一条，命中原文为整个公钥块', () => {
  const block = pemBlock('PUBLIC KEY');
  expect(detectSecrets('assets/config.pem', `\n${block}\n`)).toEqual([
    want('high-entropy', 'assets/config.pem', 2, block),
  ]);
});

it('[02 §12.6 制品#1] 二进制内容按字节检测，行号按 0x0A 计', () => {
  const bytes = Buffer.concat([
    Buffer.from([0, 1, 0xff]),
    Buffer.from(`appSecret=${FAKE.hex32Low}`),
    Buffer.from([0, 0x0a, 0x0a, 0xfe, 0]),
    Buffer.from(FAKE.akId),
    Buffer.from([0]),
  ]);
  expect(sorted(detectSecrets('lib/arm64-v8a/libdemo.so', bytes))).toEqual([
    want('server-secret', 'lib/arm64-v8a/libdemo.so', 1, FAKE.hex32Low),
    want('aliyun-access-key', 'lib/arm64-v8a/libdemo.so', 3, FAKE.akId),
  ]);
});

/** 属性回调用：不带 expect，只把「恰好一条、规则 / 行 / 原文 / 不可豁免都对」合成布尔。 */
function exactlyOne(
  hits: readonly ScanHit[],
  rule: DetectRuleId,
  line: number,
  value: string,
): boolean {
  const h = hits[0];
  return (
    hits.length === 1 &&
    h !== undefined &&
    h.rule === rule &&
    h.file === FILE &&
    h.line === line &&
    h.match === value &&
    h.never_accepted === NEVER[rule]
  );
}

const VALUE_CHARS = `${LETTERS.toUpperCase()}${LETTERS}0123456789_-`;
const chars = (alphabet: string, min: number, max: number) =>
  fc
    .array(fc.constantFrom(...alphabet.split('')), { minLength: min, maxLength: max })
    .map((cs) => cs.join(''));
const LAYOUTS = [
  (n: string, v: string) => `${n}: "${v}",`,
  (n: string, v: string) => `"${n}":"${v}"`,
  (n: string, v: string) => `${n} = '${v}';`,
  (n: string, v: string) => `${n}=${v}`,
  (n: string, v: string) => `this.${n}=\`${v}\``,
];

it('[BR-ID-09][02 §12.6 格式特征#6] 属性：任意字段名、写法、前置行数与取值，关键词规则恰好报一条且标记正确', () => {
  const stats = createPropStats('release-scan:detect:keyword');
  const arb = fc.record({
    entry: fc.constantFrom(
      ...TABLE.flatMap(([rule, names]) => names.map((name) => [rule, name] as const)),
    ),
    layout: fc.constantFrom(...LAYOUTS),
    before: fc.integer({ min: 0, max: 5 }),
    value: fc
      .oneof(chars(HEX16, 32, 32), chars(HEX16, 40, 40), chars(VALUE_CHARS, 16, 48))
      .filter((v) => /[0-9]/.test(v) && !v.includes(['LT', 'AI'].join(''))),
  });
  fc.assert(
    fc.property(arb, ({ entry: [rule, name], layout, before, value }) => {
      const content = `${'// filler\n'.repeat(before)}${layout(name, value)}\n`;
      const ok = exactlyOne(detectSecrets(FILE, content), rule, before + 1, value);
      stats.hit(ok ? 'ok' : 'bad');
      return ok;
    }),
    propParams(),
  );
  expect(stats.flush().hits).toEqual({ ok: propRuns() });
}, 900_000);
