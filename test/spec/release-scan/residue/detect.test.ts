import { expect, it } from 'vitest';
import type { ResidueHit, ResidueRuleId } from '../../../../infra/release-scan/residue/index.ts';
import { detectResidue } from '../../../../infra/release-scan/residue/index.ts';
import { axmlApplication, mobileprovision } from './fixtures.ts';

// 03 §3.6「发布制品扫描」：Release 制品不含 staging / test / local 环境的域名；不含客户端时钟偏移、环境切换、
// 诊断面板的标识；没有 debug_only 路由与桥一致性测试页入口；可调试标志关闭（Android debuggable、iOS 调试授权项
// get-task-allow、鸿蒙 debug）；WebView 调试开关关闭。任何一项命中即阻断（10 AC-S1-86 ②）。
//
// 口径（本段自定，依据见 couli-runs/QA-09c/tests-claude.md「口径」）：
// - test-domain：主机名的任一 DNS 标签再按 `-` 切开后，有一段（不分大小写）等于 staging、test、local、localhost 之一；
//   另有 127.x.x.x 与 Android 模拟器宿主 10.0.2.2。主机名只从三处取：① `<scheme>://` 之后的主机；② 引号（" ' `）
//   或 `>` `<` 恰好包住的整段「主机[:端口][/路径]」（至少两个标签）；③ 整行 `KEY=主机[:端口][/路径]`。
//   单标签的引号串（如 "test"）、JS 的 `x.test(` 不算主机。match 为主机名原文（不含端口）。
// - clock-offset / env-switch / diagnostic-panel / debug-route / conformance-entry：在「标识符」（[A-Za-z0-9_$-] 的
//   连续串）里按 `_` `$` `-` 与驼峰边界切词、转小写后，连续出现下列词序列即命中（跨标识符不算，`switch (env)` 不算）：
//   clock-offset = client clock offset；env-switch = env|environment 与 switch|switcher 相邻（任一顺序）或
//   server 与 switch|switcher 相邻；diagnostic-panel = diagnostic|diagnostics|debug|log|logs 后接 panel|menu；
//   debug-route = 路由名本身切出的词序列（HomePreview → home preview）；conformance-entry = 词 conformance，
//   或标识符恰为 `__RESULT__`。另含中文界面串：时钟偏移、切换环境 / 环境切换 / 切换服务器、诊断面板 / 调试面板 /
//   调试菜单、一致性测试。
// - debuggable：`android:debuggable="true"`；二进制 AndroidManifest 里 debuggable 布尔属性非 0；
//   `<key>get-task-allow</key>` 后（中间可有空白与换行）紧跟 `<true/>`，行号取 key 所在行；文件名为 module.json 的
//   JSON 里 `"debug": true`。
// - webview-debug：setWebContentsDebuggingEnabled(true)、setWebDebuggingAccess(true)、isInspectable = true / YES、
//   setInspectable:YES（括号与等号两侧可有空白）；取 false / NO 不命中。
// - 每处出现只报一条，行号从 1 起。

const ROUTES = { debugRoutes: ['HomePreview'] } as const;

function rulesAt(hits: readonly ResidueHit[]): Array<[string, number]> {
  return hits.map((h): [string, number] => [h.rule, h.line]).sort();
}

it.each<[string, string, string]>([
  ['https 主机', 'fetch("https://api.staging.example.com/v1/config")', 'api.staging.example.com'],
  ['标签内连字符', 'const B = "https://api-staging.example.com";', 'api-staging.example.com'],
  ['wss 与 test', 'open("wss://stream.test.example.com/agent")', 'stream.test.example.com'],
  ['大小写不敏感', "base: 'https://Api.Staging.Example.com/v1'", 'Api.Staging.Example.com'],
  ['localhost 带端口', 'const u = "http://localhost:8080/v1";', 'localhost'],
  ['回环地址', 'const u = "http://127.0.0.1:3000";', '127.0.0.1'],
  ['模拟器宿主', 'const u = "http://10.0.2.2:8080/v1";', '10.0.2.2'],
  ['.local 后缀', 'const u = "http://build-box.local/v1";', 'build-box.local'],
  ['.test 后缀', 'const u = "https://api.example.test/v1";', 'api.example.test'],
  ['引号包住的裸主机', '{"host":"api.staging.example.com"}', 'api.staging.example.com'],
  ['裸主机带端口路径', "h = 'h5.test.example.com:8443/index.html'", 'h5.test.example.com'],
  [
    'XML 元素文本',
    '<domain includeSubdomains="true">staging.example.com</domain>',
    'staging.example.com',
  ],
  ['KEY=主机 整行', 'BASE_HOST=api.staging.example.com', 'api.staging.example.com'],
])('[03 §3.6 测试域名#1] %s：命中 test-domain，match 为主机名', (_label, line, host) => {
  const hits = detectResidue('assets/app.js', `// head\n${line}\n`, ROUTES);
  expect(hits).toEqual([{ rule: 'test-domain', file: 'assets/app.js', line: 2, match: host }]);
});

it.each<[ResidueRuleId, string]>([
  ['clock-offset', 'const k = "CLIENT_CLOCK_OFFSET_SEC";'],
  ['clock-offset', 'let clientClockOffsetSec = 0;'],
  ['clock-offset', '<string name="client-clock-offset">0</string>'],
  ['clock-offset', 'label.text = "时钟偏移（秒）"'],
  ['env-switch', 'function switchEnv(target) {}'],
  ['env-switch', 'class EnvSwitcher {}'],
  ['env-switch', 'val ENVIRONMENT_SWITCH = 1'],
  ['env-switch', 'serverSwitchButton.hidden = false'],
  ['env-switch', 'title = "切换服务器"'],
  ['env-switch', 'title = "环境切换"'],
  ['diagnostic-panel', 'DiagnosticsPanel.show()'],
  ['diagnostic-panel', 'struct DebugMenuView {}'],
  ['diagnostic-panel', 'openLogPanel()'],
  ['diagnostic-panel', 'title = "诊断面板"'],
  ['diagnostic-panel', 'title = "调试菜单"'],
  ['debug-route', 'nav.open({route:"HomePreview",params:{}})'],
  ['debug-route', 'class HomePreviewActivity {}'],
  ['debug-route', 'href = "couli://home-preview?page_key=home"'],
  ['debug-route', 'case HOME_PREVIEW = 7'],
  ['conformance-entry', 'load("conformance.html")'],
  ['conformance-entry', 'const ConformanceRunner = 1'],
  ['conformance-entry', 'window.__RESULT__ = r'],
  ['conformance-entry', 'title = "桥一致性测试"'],
  ['debuggable', '<application android:debuggable="true">'],
  ['webview-debug', 'WebView.setWebContentsDebuggingEnabled(true);'],
  ['webview-debug', 'WebView.setWebContentsDebuggingEnabled( true )'],
  ['webview-debug', 'webview.WebviewController.setWebDebuggingAccess(true)'],
  ['webview-debug', 'webView.isInspectable = true'],
  ['webview-debug', 'self.webView.isInspectable=YES;'],
  ['webview-debug', '[webView setInspectable:YES];'],
])('[03 §3.6 调试标识#2] %s：%s', (rule, line) => {
  const hits = detectResidue('assets/main.js', `// head\n${line}\n`, ROUTES);
  expect(rulesAt(hits)).toEqual([[rule, 2]]);
  expect(hits[0]?.file).toBe('assets/main.js');
});

it.each<[string]>([
  ['fetch("https://api.couliapp.com/v1/config")'],
  ['const h = "https://h5.couliapp.com/index.html";'],
  ['share("https://s.couliapp.cn/p/1")'],
  ['open("https://testflight.apple.com/join/x")'],
  ['doc("https://developer.android.com/guide")'],
  ['go("https://contest.example.com/")'],
  ['go("https://latest.example.com/")'],
  ['xmlns:android="http://schemas.android.com/apk/res/android"'],
  ['/^a/.test(s)&&n.test(r)'],
  ['const mode = "test";'],
  ['const where = "local";'],
  ['const m = process.env.NODE_ENV;'],
  ['switch (env) { case "prod": break; }'],
  ['let systemClockOffset = 0;'],
  ['envelopeSwitch(); switchEnvelope();'],
  ['console.debug(x); logger.log(panel);'],
  ['nav.open({route:"Home",params:{}})'],
  ['title = "切换"'],
  ['<application android:debuggable="false">'],
  ['WebView.setWebContentsDebuggingEnabled(false);'],
  ['webview.WebviewController.setWebDebuggingAccess(false)'],
  ['webView.isInspectable = false'],
  ['[webView setInspectable:NO];'],
])('[03 §3.6 正例#3] 不含残留的 Release 内容不命中：%s', (line) => {
  expect(detectResidue('assets/main.js', `// head\n${line}\n`, ROUTES)).toEqual([]);
});

it('[03 §3.6 可调试标志#4] iOS get-task-allow 为 true 时命中（key 与值分行，行号取 key 所在行）', () => {
  const text = '<dict>\n\t<key>get-task-allow</key>\n\t<true/>\n</dict>\n';
  expect(rulesAt(detectResidue('Payload/Demo.app/Demo.xcent', text, ROUTES))).toEqual([
    ['debuggable', 2],
  ]);
  const off = '<dict>\n\t<key>get-task-allow</key>\n\t<false/>\n</dict>\n';
  expect(detectResidue('Payload/Demo.app/Demo.xcent', off, ROUTES)).toEqual([]);
});

it('[03 §3.6 可调试标志#5] 包在二进制描述文件里的 get-task-allow=true 也命中，false 不命中', () => {
  const file = 'Payload/Demo.app/embedded.mobileprovision';
  expect(detectResidue(file, mobileprovision(true), ROUTES).map((h) => [h.rule, h.file])).toEqual([
    ['debuggable', file],
  ]);
  expect(detectResidue(file, mobileprovision(false), ROUTES)).toEqual([]);
});

it('[03 §3.6 可调试标志#6] 鸿蒙 module.json 的 "debug": true 命中；false 或别的文件名不命中', () => {
  const json = (v: string) =>
    `{\n  "app": {\n    "bundleName": "com.couli.hm",\n    "debug": ${v}\n  }\n}\n`;
  expect(rulesAt(detectResidue('module.json', json('true'), ROUTES))).toEqual([['debuggable', 4]]);
  expect(rulesAt(detectResidue('entry/module.json', json('true'), ROUTES))).toEqual([
    ['debuggable', 4],
  ]);
  expect(detectResidue('module.json', json('false'), ROUTES)).toEqual([]);
  expect(detectResidue('assets/vendor/options.json', json('true'), ROUTES)).toEqual([]);
});

it('[03 §3.6 可调试标志#7] 二进制 AndroidManifest 的 debuggable 布尔属性非 0 命中，0 不命中', () => {
  const on = axmlApplication(0xffffffff);
  expect(on.readUInt16LE(0)).toBe(0x0003);
  expect(on.readUInt32LE(4)).toBe(on.length);
  expect(detectResidue('AndroidManifest.xml', on, ROUTES).map((h) => [h.rule, h.file])).toEqual([
    ['debuggable', 'AndroidManifest.xml'],
  ]);
  expect(detectResidue('AndroidManifest.xml', axmlApplication(0), ROUTES)).toEqual([]);
});

it('[03 §3.6 测试域名#8] 字节内容（latin1 / 二进制里的 URL 串）照样检测', () => {
  const bytes = Buffer.concat([
    Buffer.from([0x00, 0x1f]),
    Buffer.from('https://api.staging.example.com/v1', 'latin1'),
    Buffer.from([0x00]),
  ]);
  expect(detectResidue('classes.dex', bytes, ROUTES).map((h) => [h.rule, h.match])).toEqual([
    ['test-domain', 'api.staging.example.com'],
  ]);
});

it('[03 §3.6 测试域名#9] 同一行两处测试主机各报一条，file 原样保留', () => {
  const line = 'a("https://api.staging.example.com");b("http://localhost:3000")';
  const hits = detectResidue('Payload/Demo.app/main.jsbundle', line, ROUTES);
  expect(hits.map((h) => [h.rule, h.file, h.line, h.match]).sort()).toEqual([
    ['test-domain', 'Payload/Demo.app/main.jsbundle', 1, 'api.staging.example.com'],
    ['test-domain', 'Payload/Demo.app/main.jsbundle', 1, 'localhost'],
  ]);
});

it('[03 §3.6 debug_only 路由#10] 路由名来自配置：换成别的路由名后按新名单检测，旧名不再命中', () => {
  const text = 'a = "HomePreview";\nb = "DevConsole";\nc = "dev-console";\n';
  const custom = detectResidue('assets/main.js', text, { debugRoutes: ['DevConsole'] });
  expect(custom.map((h) => [h.rule, h.line]).sort()).toEqual([
    ['debug-route', 2],
    ['debug-route', 3],
  ]);
  const both = detectResidue('assets/main.js', text, {
    debugRoutes: ['HomePreview', 'DevConsole'],
  });
  expect(both.map((h) => [h.rule, h.line]).sort()).toEqual([
    ['debug-route', 1],
    ['debug-route', 2],
    ['debug-route', 3],
  ]);
  expect(detectResidue('assets/main.js', text, { debugRoutes: [] })).toEqual([]);
});
