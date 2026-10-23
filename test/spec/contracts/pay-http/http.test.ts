import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  at,
  check,
  compile,
  contract,
  descriptions,
  endpoints,
  envelope,
  errorCodes,
  launchSamples,
  list,
  liveCode,
  object,
  operation,
  order,
  property,
  responseSchema,
  root,
  testRequire,
  text,
  type Obj,
} from './kit.ts';

// 依据：SPEC_REF 的 BR-PAY-01～05、04 §5 / §6.4、任务书 §9。
// 这里只检查公开契约；并发锁、通知验签、记账及渠道调用留给实现任务。
it.each(endpoints)(
  '[AC-CT-21c#1] %s %s（%s）为 planned，鉴权、签名、幂等和版本门禁明确',
  async (method, path, id) => {
    const doc = await contract();
    const op = operation(doc, method, path);
    expect(op['operationId']).toBe(id);
    expect(op['x-implementation']).toBe('planned');
    expect(op['tags']).toContain('pay');
    const tag = list(doc['tags'])
      .map(object)
      .find((item) => item['name'] === 'pay');
    expect(text(object(tag)['description']).trim().length).toBeGreaterThan(0);
    expect(op['x-auth']).toBe('login');
    expect(op['security']).toEqual([{ bearerAuth: [] }]);
    expect(op['x-signed']).toBe(method === 'post');
    expect(op['x-idempotent']).toBe(id === 'createPayOrder');
    expect(op).not.toHaveProperty('x-step-up');
    if (id === 'createPayOrder') expect(op['x-session-scopes']).toEqual(['full']);
    else expect(op['x-session-scopes'] ?? ['full']).toEqual(['full']);
    if (method === 'get') expect(op).not.toHaveProperty('x-min-version-gate');
    else {
      expect(op['x-min-version-gate']).toBe(true);
      expect(list(op['x-error-codes'])).toContain(10405);
    }
  },
);

it.each(endpoints)(
  '[AC-CT-21c#2] %s %s（%s）复用公共头；只有创建需要 Idempotency-Key',
  async (method, path, id) => {
    const doc = await contract();
    const op = operation(doc, method, path);
    const parameters = [
      ...list(at(doc, 'paths', path)['parameters'] ?? []),
      ...list(op['parameters'] ?? []),
    ].map(object);
    const headers = parameters.filter((parameter) => parameter['in'] === 'header');
    const names = headers.map((header) => text(header['name']).toLowerCase());
    const common = ['AppId', 'Platform', 'AppVersion', 'Build', 'Channel', 'TraceId', 'DeviceId'];
    if (method === 'post') common.push('Timestamp', 'Nonce', 'Sign');
    if (id === 'createPayOrder') common.push('IdempotencyKey');
    for (const name of common) {
      const expected = at(doc, 'components', 'parameters', name);
      expect(headers).toContainEqual(expected);
    }
    if (method === 'get') {
      for (const name of ['x-timestamp', 'x-nonce', 'x-sign']) expect(names).not.toContain(name);
    }
    if (id === 'createPayOrder') {
      const key = headers.find((header) => header['name'] === 'Idempotency-Key');
      expect(object(key)['required']).toBe(true);
    } else expect(names).not.toContain('idempotency-key');
    expect(names).not.toContain('x-step-up-token');
    if (id !== 'createPayOrder') {
      const parameter = parameters.find((item) => item['in'] === 'path');
      expect(object(parameter)).toMatchObject({ name: 'pay_order_id', required: true });
      expect(at(parameter, 'schema')).toMatchObject({ type: 'string', format: 'uuid' });
    }
  },
);

it('[AC-CT-21c#3] 创建只收业务类型、业务对象和渠道，拒绝金额、身份与任意额外字段', async () => {
  const op = operation(await contract(), 'post', '/v1/pay/orders');
  const body = at(op, 'requestBody');
  expect(body['required']).toBe(true);
  const schema = at(body, 'content', 'application/json', 'schema');
  const keys = ['biz_ref', 'biz_type', 'pay_channel'];
  expect(Object.keys(at(schema, 'properties')).toSorted()).toEqual(keys);
  expect(list(schema['required']).toSorted()).toEqual(keys);
  expect(schema['additionalProperties']).toBe(false);
  const validate = compile(schema);
  const request: Obj = {
    biz_type: order.biz_type,
    biz_ref: order.biz_ref,
    pay_channel: 'wechat_pay',
  };
  for (const pay_channel of ['wechat_pay', 'alipay'])
    check(validate, { ...request, pay_channel }, true);
  for (const key of keys) {
    const missing = { ...request };
    delete missing[key];
    check(validate, missing, false);
    for (const value of [null, 1, {}, []]) check(validate, { ...request, [key]: value }, false);
  }
  for (const pay_channel of ['balance', 'wechat', 'wxpay', 'bank', '']) {
    check(validate, { ...request, pay_channel }, false);
  }
  for (const key of [
    'amount',
    'amount_fen',
    'total_amount',
    'price',
    'price_fen',
    'title',
    'app_id',
    'user_id',
    'extra',
  ]) {
    check(validate, { ...request, [key]: 1 }, false);
  }
});

it('[AC-CT-21c#4] 支付单公开字段完整，金额为整数分，终态时间可空且不暴露渠道用户', async () => {
  const doc = await contract();
  operation(doc, 'get', '/v1/pay/orders/{pay_order_id}');
  const schema = at(doc, 'components', 'schemas', 'PayOrder');
  const fields = at(schema, 'properties');
  expect(list(schema['required'])).toEqual(expect.arrayContaining(Object.keys(order)));
  const allowed = [...Object.keys(order), 'channel_trade_no'];
  expect(Object.keys(fields).filter((name) => !allowed.includes(name))).toEqual([]);
  expect(schema['additionalProperties']).toBe(false);
  for (const name of ['amount_fen', 'refunded_fen']) {
    expect(object(fields[name])).toMatchObject({ type: 'integer', format: 'int64' });
  }
  for (const name of ['expire_at', 'paid_at', 'closed_at', 'created_at']) {
    expect(object(fields[name])['format']).toBe('date-time');
  }
  const validate = compile(schema);
  check(validate, order, true);
  for (const status of ['PENDING', 'PAID', 'CLOSED']) check(validate, { ...order, status }, true);
  for (const status of ['SUCCESS', 'FAILED', 'REFUNDED', 'pending'])
    check(validate, { ...order, status }, false);
  for (const name of ['paid_at', 'closed_at']) {
    check(validate, { ...order, [name]: order.created_at }, true);
    check(validate, { ...order, [name]: 'invalid-time' }, false);
  }
  for (const name of ['amount_fen', 'refunded_fen']) {
    for (const value of ['101', 1.5, null]) check(validate, { ...order, [name]: value }, false);
  }
  for (const value of [0, -1]) check(validate, { ...order, amount_fen: value }, false);
  for (const key of Object.keys(order)) {
    const missing: Obj = { ...order };
    delete missing[key];
    check(validate, missing, false);
  }
  for (const name of [
    'openid',
    'payer_openid',
    'buyer_id',
    'buyer_logon_id',
    'channel_user_id',
    'private_key',
  ]) {
    check(validate, { ...order, [name]: 'forbidden' }, false);
  }
});

it('[AC-CT-21c#5] PayOrder 的状态与渠道绑定 CT-21b 枚举，创建渠道沿用同一取值', async () => {
  const doc = await contract();
  const op = operation(doc, 'post', '/v1/pay/orders');
  const schema = at(doc, 'components', 'schemas', 'PayOrder');
  const { loadEnums } = testRequire('../../../../packages/contracts-ts/scripts/catalog.ts') as {
    loadEnums(): { name: string; values: { value: string }[] }[];
  };
  const { ENUM_BINDINGS } = testRequire(
    '../../../../packages/contracts-ts/scripts/conformance.ts',
  ) as {
    ENUM_BINDINGS: Record<string, string>;
  };
  const enums = loadEnums();
  for (const [field, enumName] of [
    ['status', 'pay_order_status'],
    ['pay_channel', 'pay_channel'],
  ] as const) {
    const definition = enums.find((entry) => entry.name === enumName);
    expect(definition, `CT-21b 必须提供 ${enumName}`).toBeDefined();
    const values = definition!.values.map((entry) => entry.value).toSorted();
    expect(list(at(schema, 'properties', field)['enum']).toSorted()).toEqual(values);
    // 可以绑定 PayOrder 的字段，也可以绑定它引用的共享 schema。
    const bindings = Object.entries(ENUM_BINDINGS).filter(([, name]) => name === enumName);
    expect(
      bindings.some(([pointer]) => {
        const bound = at(doc, 'components', 'schemas', ...pointer.split('/'));
        return JSON.stringify(bound) === JSON.stringify(at(schema, 'properties', field));
      }),
    ).toBe(true);
    if (field === 'pay_channel') {
      const request = at(op, 'requestBody', 'content', 'application/json', 'schema');
      expect(list(at(request, 'properties', field)['enum']).toSorted()).toEqual(values);
    }
  }
});

it('[AC-CT-21c#6] 调起参数 oneOf 分微信与支付宝，必填 SDK 字段，标待实测且禁止日志', async () => {
  const doc = await contract();
  const op = operation(doc, 'post', '/v1/pay/orders');
  const schema = responseSchema(op);
  const data = property(schema, 'data');
  const payOrder = at(doc, 'components', 'schemas', 'PayOrder');
  for (const key of Object.keys(order)) {
    expect(property(data, key)).toEqual(property(payOrder, key));
  }
  const launch = property(data, 'launch');
  expect(launch['x-no-log']).toBe(true);
  const notes = descriptions(launch);
  expect(notes).toContain('CAP-X-16');
  expect(notes).toContain('CAP-X-17');
  expect(notes).toMatch(/待.*实测|pending.*verif|not.*verified/iu);
  expect(notes).toMatch(/不.{0,8}日志|no.{0,8}log|must not.{0,8}log/iu);
  const branches = list(launch['oneOf']).map(object);
  expect(branches).toHaveLength(2);
  const validate = compile(schema);
  for (const [pay_channel, sample] of Object.entries(launchSamples)) {
    const marker = pay_channel === 'wechat_pay' ? 'prepayid' : 'order_str';
    const matches = branches.filter((branch) =>
      Object.hasOwn(object(branch['properties'] ?? {}), marker),
    );
    expect(matches, `缺少 ${pay_channel} SDK 调起分支`).toHaveLength(1);
    const branch = object(matches[0]);
    const fields = at(branch, 'properties');
    expect(
      Object.keys(fields)
        .filter((key) => key !== 'pay_channel')
        .toSorted(),
    ).toEqual(Object.keys(sample).toSorted());
    expect(list(branch['required'])).toEqual(expect.arrayContaining(Object.keys(sample)));
    expect(branch['additionalProperties']).toBe(false);
    for (const key of Object.keys(sample)) expect(object(fields[key])['type']).toBe('string');
    const payload = Object.hasOwn(fields, 'pay_channel') ? { pay_channel, ...sample } : sample;
    if (Object.hasOwn(fields, 'pay_channel')) {
      const discriminator = object(fields['pay_channel']);
      if (discriminator['const'] !== undefined) expect(discriminator['const']).toBe(pay_channel);
      else expect(discriminator['enum']).toEqual([pay_channel]);
      expect(list(branch['required'])).toContain('pay_channel');
    }
    const response = (value: Obj) => envelope({ ...order, pay_channel, launch: value });
    check(validate, response(payload), true);
    for (const key of Object.keys(sample)) {
      const missing = { ...payload };
      delete missing[key];
      check(validate, response(missing), false);
    }
    const other = object(launchSamples[pay_channel === 'wechat_pay' ? 'alipay' : 'wechat_pay']);
    check(validate, response({ ...payload, ...other }), false);
    check(validate, response({ ...payload, private_key: 'forbidden' }), false);
    check(validate, envelope({ ...order, pay_channel }), false);
    for (const key of Object.keys(order)) {
      const missing: Obj = { ...order, pay_channel, launch: payload };
      delete missing[key];
      check(validate, envelope(missing), false);
    }
  }
  check(validate, envelope({ ...order, launch: {} }), false);
});

it.each([endpoints[1], endpoints[3]])(
  '[AC-CT-21c#7] %s %s（%s）只返回支付单，不重新泄露调起参数',
  async (method, path) => {
    const doc = await contract();
    const op = operation(doc, method, path);
    expect(op).not.toHaveProperty('requestBody');
    const schema = responseSchema(op);
    expect(property(schema, 'data')).toEqual(at(doc, 'components', 'schemas', 'PayOrder'));
    const validate = compile(schema);
    check(validate, envelope(order), true);
    check(validate, envelope({ ...order, launch: launchSamples['wechat_pay'] }), false);
    check(validate, envelope(null), false);
  },
);

it('[AC-CT-21c#8] returned 无请求体和 SDK 结果，只触发一次立即查询，data 为空对象', async () => {
  const op = operation(await contract(), 'post', '/v1/pay/orders/{pay_order_id}/returned');
  expect(op).not.toHaveProperty('requestBody');
  const description = text(op['description']).replace(/\s+/g, ' ');
  expect(description).toMatch(/一次|\bonce\b|\bsingle\b/iu);
  expect(description).toMatch(/立即.*查询|immediate.*quer/iu);
  expect(description).toMatch(/SDK/iu);
  expect(description).toMatch(/不带|不接受|不作为|no .*result|not .*result|without .*result/iu);
  const validate = compile(responseSchema(op));
  check(validate, envelope({}), true);
  for (const data of [null, [], '', { status: 'PAID' }, { sdk_result: 'success' }]) {
    check(validate, envelope(data), false);
  }
});

it('[AC-CT-21c#9] 查询限本人，取消先查后关且异步，非 PENDING 为 20902/pay_order', async () => {
  const doc = await contract();
  const get = operation(doc, 'get', '/v1/pay/orders/{pay_order_id}');
  expect(text(get['description'])).toMatch(/本人|own|owner/iu);
  expect(text(get['description'])).toMatch(/404/);
  const cancel = operation(doc, 'post', '/v1/pay/orders/{pay_order_id}/cancel');
  const description = text(cancel['description']).replace(/\s+/g, ' ');
  expect(description).toMatch(/查询.*关单|quer.*clos/iu);
  expect(description).toMatch(/异步|asynchron/iu);
  expect(description).toMatch(/PENDING/);
  expect(description).toMatch(/20902/);
  expect(description).toMatch(/pay_order/);
});

it('[AC-CT-21c#10] 创建仅限原生本人，支持同渠道待支付原单复用，调起不下发私钥', async () => {
  const op = operation(await contract(), 'post', '/v1/pay/orders');
  const description = text(op['description']).replace(/\s+/g, ' ');
  expect(description).toMatch(/原生|native/iu);
  for (const name of ['H5', 'JSBridge', 'Agent'])
    expect(description).toMatch(new RegExp(name, 'iu'));
  expect(description).toMatch(/本人|own|owner/iu);
  expect(description).toMatch(/PENDING/);
  expect(description).toMatch(/同.{0,8}渠道|same.channel/iu);
  expect(description).toMatch(/原单|existing|original/iu);
  expect(description).toMatch(/X-Platform/);
  expect(descriptions(op)).toMatch(/私钥|private.key/iu);
});

it.each(endpoints)(
  '[AC-CT-21c#11] %s %s（%s）错误码已登记且不误列二次验证 20903',
  async (method, path, id) => {
    const doc = await contract();
    const op = operation(doc, method, path);
    const codes = list(op['x-error-codes']);
    const expected = method === 'post' ? [10405] : [];
    if (id === 'createPayOrder') expected.push(30901, 30902, 50306, 20901);
    if (id === 'cancelPayOrder') expected.push(20902);
    expect(codes).toEqual(expect.arrayContaining(expected));
    expect(codes).not.toContain(20903);
    if (id !== 'createPayOrder') {
      // 关闭开关仅阻止新下单，不阻止查询和关单。
      for (const code of [30901, 30902, 50306]) expect(codes).not.toContain(code);
    }
    const catalog = errorCodes();
    for (const code of codes) {
      expect(code).toBeTypeOf('number');
      liveCode(catalog, code as number);
    }
    for (const status of ['4XX', '5XX']) {
      expect(at(op, 'responses', status, 'content', 'application/json', 'schema')).toEqual(
        at(doc, 'components', 'schemas', 'ErrorEnvelope'),
      );
    }
  },
);

it('[AC-CT-21c#12] 四个原生支付接口存在时，Bridge 全文与 Agent 白名单均无支付入口', async () => {
  const doc = await contract();
  // 同时证明原生侧入口存在，避免「全删支付接口」仍满足隔离断言。
  for (const [method, path, id] of endpoints)
    expect(operation(doc, method, path)['operationId']).toBe(id);
  for (const file of ['contracts/bridge.schema.json', 'specs/agent-tools.allowlist']) {
    expect(readFileSync(new URL(file, root), 'utf8'), file).not.toContain('/v1/pay/');
  }
});

it('[AC-CT-21c#13] planned 支付接口同步鉴权、签名、版本表，尚不进入运行时请求 schema', async () => {
  const doc = await contract();
  for (const [method, path] of endpoints) operation(doc, method, path);
  const tables = [
    ['apps/api/src/modules/platform/http/auth-routes.gen.ts', 'CONTRACT_AUTH_ROUTES'],
    ['apps/api/src/modules/platform/validation/signing-routes.gen.ts', 'CONTRACT_SIGNING_ROUTES'],
    [
      'apps/api/src/modules/risk/application/min-version-routes.gen.ts',
      'CONTRACT_MIN_VERSION_ROUTES',
    ],
  ];
  for (const [file, exportName] of tables) {
    const module = object(await import(new URL(file!, root).href));
    const entries = list(module[exportName!]).map(object);
    for (const [method, path, id] of endpoints) {
      const matches = entries.filter(
        (entry) =>
          entry['method'] === method.toUpperCase() &&
          entry['path'] === path.replace('{pay_order_id}', ':pay_order_id'),
      );
      expect(matches, `${file}: ${id}`).toHaveLength(1);
      const entry = object(matches[0]);
      if (exportName === 'CONTRACT_AUTH_ROUTES') expect(entry['auth']).toBe('login');
      else if (exportName === 'CONTRACT_SIGNING_ROUTES')
        expect(entry['signed']).toBe(method === 'post');
      else
        expect(entry).toMatchObject({
          operationId: id,
          gate: method === 'post' ? true : null,
          sessionScopes: ['full'],
          idempotent: id === 'createPayOrder',
        });
    }
  }
  const module = object(
    await import(
      new URL('apps/api/src/modules/platform/validation/route-schemas.gen.ts', root).href
    ),
  );
  const schemas = object(module['CONTRACT_ROUTE_SCHEMAS']);
  for (const [, , id] of endpoints) expect(schemas).not.toHaveProperty(id);
});

it('[AC-CT-21c#14] 支付契约存在且 contracts:check 核对生成类型无漂移', async () => {
  const doc = await contract();
  for (const [method, path] of endpoints) operation(doc, method, path);
  const parent = fileURLToPath(new URL('.tmp/ct-21c-contracts/', root));
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'check-'));
  try {
    // 仅由容器运行本测试；不写生成物，漂移诊断的临时文件也留在仓库 .tmp 下。
    const result = spawnSync('pnpm', ['contracts:check'], {
      cwd: fileURLToPath(root),
      env: { ...process.env, TMPDIR: directory },
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.error, 'contracts:check 应能在验证容器中启动').toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 100_000);
