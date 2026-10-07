import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CliFinding, CliReport } from '../../../../infra/release-scan/cli.ts';
import { main } from '../../../../infra/release-scan/cli.ts';
import type { ZipFile } from '../detect/fixtures.ts';
import {
  FAKE,
  axmlApplication,
  dexWith,
  manifestWith,
  mobileprovision,
  realManifest,
  spread,
  tempDirs,
  writeText,
  writeTree,
  writeZip,
} from './fixtures.ts';

// 命令行入口装配（台账 QA-09c 注释；05 QA-09；03 §3.6；02 §12.6；10 AC-S1-86 ①②）：
// 读取 → 密钥检测（QA-09b）→ 白名单比对（QA-09a）→ --release 时另跑残留规则；残留命中一律阻断，
// 不经误报清单与例外豁免。口径（QA-09b 评审转来，couli-runs/CODEX-IMPL/followups.md）：
// 退出码 0 通过、1 有阻断、2 用法错误或读取 / 解析失败；阈值只能调严；命中的密钥原文不出现在输出里；
// 只经 process.stdout.write / stderr.write 输出（infra/** 不用 console）。标准输出是一份 JSON 报告（CliReport）。

const newDir = tempDirs();
const text = (chunk: string | Uint8Array): string =>
  typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
let out: string[] = [];
let err: string[] = [];
const consoles: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out.push(text(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    err.push(text(chunk));
    return true;
  });
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    consoles.push(vi.spyOn(console, m).mockImplementation(() => undefined));
  }
});

afterEach(() => {
  for (const spy of consoles)
    expect(spy, '[03 §3.6 输出#0] 不经 console 输出').not.toHaveBeenCalled();
  consoles.length = 0;
  vi.restoreAllMocks();
});

/** 清单与批准记录文件（调用方从可信来源提供）；manifest 缺省为仓库真实清单。 */
function lists(dir: string, manifest = realManifest()): string[] {
  const approvals = 'approvals:\n  - id: 30\n    granted: true\n';
  return [
    '--manifest',
    writeText(dir, 'ids.yaml', manifest),
    '--approvals',
    writeText(dir, 'ap.yaml', approvals),
  ];
}

async function run(args: readonly string[]): Promise<{ code: number; report: CliReport }> {
  const code = await main(args);
  return { code, report: JSON.parse(out.join('')) as CliReport };
}

function blocks(report: CliReport): string[][] {
  return report.findings
    .filter((f: CliFinding) => f.verdict === 'block')
    .map((f) => [f.kind, f.rule, f.file])
    .sort();
}

const PROD = 'https://api.couliapp.com/v1';
const IPA_CLEAN: ZipFile[] = [
  {
    name: 'Payload/Demo.app/Info.plist',
    data: `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleIdentifier</key><string>com.couli.app</string>\n<key>ApiBase</key><string>${PROD}</string>\n</dict></plist>\n`,
  },
  { name: 'Payload/Demo.app/main.jsbundle', data: `fetch("${PROD}/config")` },
  { name: 'Payload/Demo.app/embedded.mobileprovision', data: mobileprovision(false) },
];
const APK_CLEAN: ZipFile[] = [
  { name: 'AndroidManifest.xml', data: axmlApplication(0) },
  { name: 'classes.dex', data: dexWith(PROD) },
  { name: 'assets/index.android.bundle', data: `fetch("${PROD}/config")` },
];
const HAP_MODULE = (debug: boolean) =>
  `{\n  "app": {\n    "bundleName": "com.couli.hm",\n    "debug": ${String(debug)}\n  }\n}\n`;
const HAP_CLEAN: ZipFile[] = [
  { name: 'module.json', data: HAP_MODULE(false) },
  { name: 'ets/modules.abc', data: `fetch("${PROD}/config")` },
];

/** 把基准制品里同名条目换掉（或追加）。 */
function withEntry(base: readonly ZipFile[], entry: ZipFile): ZipFile[] {
  return [...base.filter((f) => f.name !== entry.name), entry];
}

it.each<[string, string, ZipFile[]]>([
  ['ios', 'clean.ipa', IPA_CLEAN],
  ['android', 'clean.apk', APK_CLEAN],
  ['harmony', 'clean.hap', HAP_CLEAN],
])(
  '[AC-S1-86#1] 干净的 %s Release 制品带 --release 扫描通过：退出码 0，无阻断',
  async (platform, name, files) => {
    const dir = newDir();
    const { code, report } = await run([
      writeZip(dir, name, files),
      '--platform',
      platform,
      '--release',
      ...lists(dir),
    ]);
    expect(code).toBe(0);
    expect(report).toMatchObject({ exit_code: 0, passed: true, release: true, errors: [] });
    expect(blocks(report)).toEqual([]);
  },
);

const IMPLANTS: Array<[string, ZipFile, string]> = [
  [
    '测试环境域名',
    { name: 'classes.dex', data: dexWith('https://api.staging.example.com/v1') },
    'test-domain',
  ],
  [
    '时钟偏移的读取',
    { name: 'assets/index.android.bundle', data: 'const o = cfg("CLIENT_CLOCK_OFFSET_SEC");' },
    'clock-offset',
  ],
  [
    'HomePreview 路由',
    { name: 'assets/routes.json', data: '{"HomePreview":{"kind":"native"}}' },
    'debug-route',
  ],
  ['可调试标志', { name: 'AndroidManifest.xml', data: axmlApplication(0xffffffff) }, 'debuggable'],
  [
    'WebView 调试开关',
    { name: 'assets/index.android.bundle', data: 'WebView.setWebContentsDebuggingEnabled(true);' },
    'webview-debug',
  ],
];

it.each(IMPLANTS)(
  '[AC-S1-86#2] Release apk 里故意留下%s：--release 扫描阻断，退出码 1',
  async (_l, entry, rule) => {
    const dir = newDir();
    const path = writeZip(dir, 'release.apk', withEntry(APK_CLEAN, entry));
    const { code, report } = await run([path, '--platform', 'android', '--release', ...lists(dir)]);
    expect(code).toBe(1);
    expect(report).toMatchObject({ exit_code: 1, passed: false, release: true, errors: [] });
    expect(blocks(report)).toEqual([['residue', rule, entry.name]]);
  },
);

it.each<[string, string, ZipFile[], ZipFile]>([
  [
    'ios get-task-allow',
    'release.ipa',
    IPA_CLEAN,
    { name: 'Payload/Demo.app/embedded.mobileprovision', data: mobileprovision(true) },
  ],
  ['harmony debug', 'release.hap', HAP_CLEAN, { name: 'module.json', data: HAP_MODULE(true) }],
])('[AC-S1-86#2] 可调试标志（%s）打开的 Release 制品被阻断', async (_l, name, base, entry) => {
  const dir = newDir();
  const platform = name.endsWith('.ipa') ? 'ios' : 'harmony';
  const { code, report } = await run([
    writeZip(dir, name, withEntry(base, entry)),
    '--platform',
    platform,
    '--release',
    ...lists(dir),
  ]);
  expect(code).toBe(1);
  expect(blocks(report)).toEqual([['residue', 'debuggable', entry.name]]);
});

it.each(IMPLANTS)(
  '[03 §3.6 开关#3] 不带 --release 时不跑残留规则（%s）：退出码 0，无残留命中',
  async (_l, entry) => {
    const dir = newDir();
    const path = writeZip(dir, 'staging.apk', withEntry(APK_CLEAN, entry));
    const { code, report } = await run([path, '--platform', 'android', ...lists(dir)]);
    expect(code).toBe(0);
    expect(report).toMatchObject({ exit_code: 0, passed: true, release: false });
    expect(report.findings.filter((f) => f.kind === 'residue')).toEqual([]);
  },
);

it('[03 §3.6 不可豁免#4] 误报清单与已批准例外写了残留命中的 rule 与 file，仍然阻断', async () => {
  const dir = newDir();
  const file = 'assets/index.android.bundle';
  const manifest = manifestWith(
    [
      'false_positives:',
      `  - rule: test-domain\n    file: ${file}\n    reason: 试图豁免残留`,
      'exceptions:',
      `  - sdk: 示例 SDK\n    item: 示例项\n    rule: test-domain\n    file: ${file}`,
      '    scope_if_leaked: 无\n    server_side_limit: 无\n    approval: 30',
      '',
    ].join('\n'),
  );
  const path = writeZip(
    dir,
    'release.apk',
    withEntry(APK_CLEAN, { name: file, data: 'fetch("https://api.staging.example.com/v1")' }),
  );
  const { code, report } = await run([
    path,
    '--platform',
    'android',
    '--release',
    ...lists(dir, manifest),
  ]);
  expect(code).toBe(1);
  expect(blocks(report)).toEqual([['residue', 'test-domain', file]]);
});

it('[03 §3.6 测试域名#5] --release 扫 H5 构建产物目录时同样检测测试环境域名', async () => {
  const dir = newDir();
  const root = writeTree(join(dir, 'dist'), {
    'assets/index.js': 'fetch("https://h5.test.example.com/x")',
  });
  const { code, report } = await run([root, '--platform', 'h5', '--release', ...lists(dir)]);
  expect(code).toBe(1);
  expect(blocks(report)).toEqual([['residue', 'test-domain', 'assets/index.js']]);
});

it('[03 §3.6 debug_only 路由#6] 缺省读仓库 contracts/routes.json；--routes 换名单后按新名单检测', async () => {
  const dir = newDir();
  const routes = writeText(
    dir,
    'routes.json',
    JSON.stringify({
      version: '1',
      routes: { DevConsole: { debug_only: true }, HomePreview: { debug_only: false } },
    }),
  );
  const home = writeZip(
    dir,
    'home.apk',
    withEntry(APK_CLEAN, { name: 'assets/r.json', data: '["HomePreview"]' }),
  );
  const dev = writeZip(
    dir,
    'dev.apk',
    withEntry(APK_CLEAN, { name: 'assets/r.json', data: '["DevConsole"]' }),
  );
  const base = ['--platform', 'android', '--release', ...lists(dir)];
  expect((await run([home, ...base, '--routes', routes])).code).toBe(0);
  out = [];
  const custom = await run([dev, ...base, '--routes', routes]);
  expect(custom.code).toBe(1);
  expect(blocks(custom.report)).toEqual([['residue', 'debug-route', 'assets/r.json']]);
  out = [];
  expect((await run([dev, ...base])).code).toBe(0);
});

/** 秘密原文长度 ≥ 9 的任何片段都不得出现在输出里（只许规则、文件、行号、指纹或前后少量字符）。 */
function expectRedacted(secret: string): void {
  const text = out.join('') + err.join('');
  for (let i = 0; i + 9 <= secret.length; i++) {
    expect(text.includes(secret.slice(i, i + 9)), `输出含原文片段 ${String(i)}`).toBe(false);
  }
}

it('[02 §12.6 脱敏#7] 服务端密钥命中阻断（不带 --release 也查），报告给规则、文件、行号，不输出原文', async () => {
  const dir = newDir();
  const path = writeZip(
    dir,
    'demo.apk',
    withEntry(APK_CLEAN, { name: 'assets/conf.json', data: `{\n"appSecret":"${FAKE.hex32Low}"}` }),
  );
  const { code, report } = await run([path, '--platform', 'android', ...lists(dir)]);
  expect(code).toBe(1);
  expect(report.findings.filter((f) => f.verdict === 'block')).toEqual([
    expect.objectContaining({
      kind: 'secret',
      rule: 'server-secret',
      file: 'assets/conf.json',
      line: 2,
    }),
  ]);
  expectRedacted(FAKE.hex32Low);
});

it.each<[string, string]>([
  ['--min-length', '21'],
  ['--min-length', '64'],
  ['--min-entropy', '3.6'],
  ['--min-entropy', '5'],
  ['--min-length', 'abc'],
  ['--min-entropy', 'NaN'],
  ['--min-length', ''],
])('[02 §12.6 阈值#8] %s %s 调松或不是数值：用法错误，退出码 2', async (flag, value) => {
  const dir = newDir();
  const path = writeZip(dir, 'clean.apk', APK_CLEAN);
  const code = await main([path, '--platform', 'android', ...lists(dir), flag, value]);
  expect(code).toBe(2);
  expect((out.join('') + err.join('')).length).toBeGreaterThan(0);
});

it.each<[string, string, string]>([
  ['--min-length', '16', spread(16, 16)],
  ['--min-entropy', '3', spread(8, 24)],
])(
  '[02 §12.6 阈值#9] %s %s 调严后生效：默认放过的串被检出阻断，且不输出原文',
  async (flag, value, s) => {
    const dir = newDir();
    const root = writeTree(join(dir, 'dist'), { 'assets/index.js': `var a="${s}";` });
    const loose = await run([root, '--platform', 'h5', ...lists(dir)]);
    expect(loose.code).toBe(0);
    out = [];
    const strict = await run([root, '--platform', 'h5', ...lists(dir), flag, value]);
    expect(strict.code).toBe(1);
    expect(blocks(strict.report)).toEqual([['secret', 'high-entropy', 'assets/index.js']]);
    expectRedacted(s);
    out = [];
    const equal = flag === '--min-length' ? '20' : '3.5';
    expect((await run([root, '--platform', 'h5', ...lists(dir), flag, equal])).code).toBe(0);
  },
);

it.each<[string, (dir: string) => string[]]>([
  ['缺制品路径', (d) => ['--platform', 'android', ...lists(d)]],
  ['缺 --platform', (d) => [writeZip(d, 'a.apk', APK_CLEAN), ...lists(d)]],
  ['未知端', (d) => [writeZip(d, 'a.apk', APK_CLEAN), '--platform', 'windows', ...lists(d)]],
  [
    '未知参数',
    (d) => [writeZip(d, 'a.apk', APK_CLEAN), '--platform', 'android', '--allow-all', ...lists(d)],
  ],
  [
    '缺 --manifest',
    (d) => [writeZip(d, 'a.apk', APK_CLEAN), '--platform', 'android', ...lists(d).slice(2)],
  ],
  [
    '缺 --approvals',
    (d) => [writeZip(d, 'a.apk', APK_CLEAN), '--platform', 'android', ...lists(d).slice(0, 2)],
  ],
  [
    '清单文件不存在',
    (d) => [
      writeZip(d, 'a.apk', APK_CLEAN),
      '--platform',
      'android',
      '--manifest',
      join(d, 'none.yaml'),
      ...lists(d).slice(2),
    ],
  ],
  [
    '批准记录文件不存在',
    (d) => [
      writeZip(d, 'a.apk', APK_CLEAN),
      '--platform',
      'android',
      ...lists(d).slice(0, 2),
      '--approvals',
      join(d, 'none.yaml'),
    ],
  ],
  [
    '批准记录读不通',
    (d) => [
      writeZip(d, 'a.apk', APK_CLEAN),
      '--platform',
      'android',
      ...lists(d).slice(0, 2),
      '--approvals',
      writeText(d, 'bad.yaml', 'approvals: [\n'),
    ],
  ],
  [
    '清单无效',
    (d) => [
      writeZip(d, 'a.apk', APK_CLEAN),
      '--platform',
      'android',
      ...lists(d, "version: '1'\n"),
    ],
  ],
  ['制品不存在', (d) => [join(d, 'none.apk'), '--platform', 'android', ...lists(d)]],
  [
    '制品损坏',
    (d) => [
      writeText(d, 'bad.apk', 'PK\u0003\u0004 not a zip'),
      '--platform',
      'android',
      ...lists(d),
    ],
  ],
  ['端与制品不符', (d) => [writeZip(d, 'a.apk', APK_CLEAN), '--platform', 'ios', ...lists(d)]],
  [
    '二进制清单文件损坏',
    (d) => [
      writeZip(
        d,
        'a.apk',
        withEntry(APK_CLEAN, {
          name: 'AndroidManifest.xml',
          data: axmlApplication(0).subarray(0, 40),
        }),
      ),
      '--platform',
      'android',
      '--release',
      ...lists(d),
    ],
  ],
  [
    '--release 时 routes 读不通',
    (d) => [
      writeZip(d, 'a.apk', APK_CLEAN),
      '--platform',
      'android',
      '--release',
      '--routes',
      writeText(d, 'r.json', '{"routes":'),
      ...lists(d),
    ],
  ],
  [
    '--release 时 routes 文件不存在',
    (d) => [
      writeZip(d, 'a.apk', APK_CLEAN),
      '--platform',
      'android',
      '--release',
      '--routes',
      join(d, 'none.json'),
      ...lists(d),
    ],
  ],
])('[02 §12.6 退出码#10] %s：退出码 2（fail-closed），并给出说明', async (_l, args) => {
  const code = await main(args(newDir()));
  expect(code).toBe(2);
  expect((out.join('') + err.join('')).length).toBeGreaterThan(0);
});

it('[02 §12.6 退出码#11] 残留与密钥同时命中时两类都列出，报告经标准输出写出', async () => {
  const dir = newDir();
  const files = withEntry(
    withEntry(APK_CLEAN, { name: 'assets/conf.json', data: `{"appSecret":"${FAKE.hex32Low}"}` }),
    {
      name: 'assets/index.android.bundle',
      data: 'fetch("http://localhost:8080/v1")',
    },
  );
  const { code, report } = await run([
    writeZip(dir, 'release.apk', files),
    '--platform',
    'android',
    '--release',
    ...lists(dir),
  ]);
  expect(code).toBe(1);
  expect(blocks(report)).toEqual([
    ['residue', 'test-domain', 'assets/index.android.bundle'],
    ['secret', 'server-secret', 'assets/conf.json'],
  ]);
  expectRedacted(FAKE.hex32Low);
});
