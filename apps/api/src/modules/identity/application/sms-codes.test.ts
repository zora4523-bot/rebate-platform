// Unit tests of the SMS code service around Redis: the scripts themselves run against a real Redis
// in the rule tests (test/spec/identity/sms-codes); here the namespace is a stub that answers
// each script with a canned reply, to pin the order of checks, the short-circuits of the insertion
// points and the handling of every sender and Redis outcome.
import { createHmac } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  FixedClock,
  RedisUnavailableError,
  createRootLogger,
  type RedisHandle,
  type RedisScriptOptions,
} from '../../platform/index.ts';
import {
  createSmsCodeService,
  type SmsHooks,
  type SmsMessage,
  type SmsSender,
} from './sms-codes.ts';

const NUMBER = '13912345678';
const START = '2026-10-06T10:00:00+08:00';

type Kind = 'reserve' | 'confirm' | 'release' | 'store' | 'verify';
interface Call {
  readonly kind: Kind;
  readonly namespace: string;
  readonly options: RedisScriptOptions;
}

function kindOf(script: string, options: RedisScriptOptions): Kind {
  const key = options.keys[0] ?? '';
  if (key.startsWith('q:')) {
    if (options.args.length === 1) return 'release';
    return script.includes("'a:' .. token") ? 'confirm' : 'reserve';
  }
  return options.args.length === 3 ? 'store' : 'verify';
}

function setup(
  overrides: {
    hooks?: SmsHooks;
    sender?: SmsSender;
    reply?: (kind: Kind, options: RedisScriptOptions) => unknown;
    config?: unknown;
  } = {},
) {
  const clock = new FixedClock(START);
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const calls: Call[] = [];
  const reply =
    overrides.reply ??
    ((kind: Kind) =>
      ({
        reserve: [1, 0],
        confirm: clock.now().getTime() + 60_000,
        release: 1,
        store: 1,
        verify: 3,
      })[kind]);
  const redis: RedisHandle = {
    namespace: (namespace: string) => ({
      get: async () => {
        throw new Error('the SMS code store only runs scripts');
      },
      set: async () => {
        throw new Error('the SMS code store only runs scripts');
      },
      eval: async (script: string, options: RedisScriptOptions) => {
        const kind = kindOf(script, options);
        calls.push({ kind, namespace, options });
        return reply(kind, options);
      },
    }),
    close: async () => undefined,
    onApplicationShutdown: async () => undefined,
  };
  const messages: SmsMessage[] = [];
  const sender: SmsSender = overrides.sender ?? {
    send: async (message) => {
      messages.push(message);
      return 'accepted';
    },
  };
  const key = Buffer.alloc(32, 7);
  const hmac = vi.fn((text: string) => createHmac('sha256', key).update(text).digest('hex'));
  const configValue = vi.fn(async () =>
    overrides.config === undefined ? null : { value: overrides.config, version: 3 },
  );
  const service = createSmsCodeService({
    clock,
    redis,
    sender,
    logger,
    hmac,
    config: { configValue },
    ...(overrides.hooks === undefined ? {} : { hooks: overrides.hooks }),
  });
  const send = (phone = NUMBER) => service.send({ app_id: 'couli', phone, purpose: 'login' });
  return { clock, lines, calls, messages, hmac, configValue, service, send };
}

it('[BR-ID-05] the blocklist insertion point gets the normalised number, and its 44001 short-circuits the rest', async () => {
  const phoneBlocklist = vi.fn(async () => ({
    code: 44001 as const,
    kind: 'phone_blocklist' as const,
  }));
  const captcha = vi.fn(async () => null);
  const deviceQuota = vi.fn(async () => null);
  const afterAccepted = vi.fn(async () => undefined);
  const f = setup({ hooks: { phoneBlocklist, captcha, deviceQuota, afterAccepted } });
  expect(await f.send(`+86 ${NUMBER}`)).toEqual({ code: 44001, kind: 'phone_blocklist' });
  expect(phoneBlocklist).toHaveBeenCalledTimes(1);
  expect(phoneBlocklist).toHaveBeenCalledWith(
    expect.objectContaining({ app_id: 'couli', phone: NUMBER, purpose: 'login' }),
  );
  expect(captcha).not.toHaveBeenCalled();
  expect(deviceQuota).not.toHaveBeenCalled();
  expect(afterAccepted).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
  expect(f.messages).toEqual([]);
});

it('[BR-ID-05] a device-quota 42901 short-circuits before the phone quota: nothing reserved or sent', async () => {
  const deviceQuota = vi.fn(async () => ({ code: 42901 as const, retryAfterSec: 1200 }));
  const afterAccepted = vi.fn(async () => undefined);
  const f = setup({ hooks: { deviceQuota, afterAccepted } });
  expect(await f.send()).toEqual({ code: 42901, retryAfterSec: 1200 });
  expect(f.calls).toEqual([]);
  expect(f.messages).toEqual([]);
  expect(afterAccepted).not.toHaveBeenCalled();
});

it('[BR-ID-05] a captcha 44003 short-circuits before the device quota', async () => {
  const deviceQuota = vi.fn(async () => null);
  const f = setup({ hooks: { captcha: async () => ({ code: 44003 }), deviceQuota } });
  expect(await f.send()).toEqual({ code: 44003 });
  expect(deviceQuota).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
});

it('[BR-ID-05] keys and stored values carry HMACs only, with the quota and code TTLs', async () => {
  const f = setup();
  expect(await f.send(`0086 ${NUMBER}`)).toEqual({
    code: 0,
    data: { resend_after_sec: 60, expires_in_sec: 300 },
  });
  expect(f.calls.map((call) => call.kind)).toEqual(['reserve', 'confirm', 'store']);
  for (const call of f.calls) {
    expect(call.namespace).toBe('sms');
    expect(JSON.stringify(call.options)).not.toContain(NUMBER);
  }
  const code = f.messages[0]!.code;
  expect(code).toMatch(/^[0-9]{6}$/);
  const [reserve, confirm, store] = f.calls;
  expect(reserve!.options.ttlSeconds).toBe(90_000);
  expect(confirm!.options.keys).toEqual(reserve!.options.keys);
  expect(reserve!.options.keys[0]).toMatch(/^q:[0-9a-f]{64}$/);
  expect(store!.options.ttlSeconds).toBe(300);
  expect(store!.options.keys[0]).toMatch(/^c:couli:login:[0-9a-f]{64}$/);
  expect(store!.options.args).not.toContain(code);
  expect(store!.options.args[0]).toBe(f.hmac.mock.results.at(-1)!.value);
  expect(f.hmac.mock.calls.at(-1)![0]).toContain(code);
});

it('[BR-ID-05] resend_after_sec is the time until the next send may go (latest release, at least 60)', async () => {
  const nextHour = new Date('2026-10-06T11:00:00+08:00').getTime();
  const f = setup({
    reply: (kind) => (kind === 'reserve' ? [1, 0] : kind === 'confirm' ? nextHour : 1),
  });
  expect(await f.send()).toEqual({
    code: 0,
    data: { resend_after_sec: 3600, expires_in_sec: 300 },
  });
});

it('[BR-ID-05] a limit answers 42901 with the seconds until the release the script reports', async () => {
  const release = new Date(START).getTime() + 55_000;
  const f = setup({ reply: (kind) => (kind === 'reserve' ? [0, release] : 1) });
  expect(await f.send()).toEqual({ code: 42901, retryAfterSec: 55 });
  expect(f.messages).toEqual([]);
});

it('[BR-ID-05] Redis unavailable at the reservation: 42901 with Retry-After 5, nothing sent, no number logged', async () => {
  const f = setup({
    reply: () => {
      throw new RedisUnavailableError('connect_failed', 'ECONNREFUSED');
    },
  });
  expect(await f.send(`+86 ${NUMBER}`)).toEqual({ code: 42901, retryAfterSec: 5 });
  expect(f.messages).toEqual([]);
  expect(f.lines.join('')).toContain('sms_quota_unavailable');
  expect(f.lines.join('')).not.toContain(NUMBER);
});

it('[BR-ID-05] any other error of the store is not turned into a rate limit', async () => {
  const f = setup({
    reply: () => {
      throw new TypeError('bug');
    },
  });
  await expect(f.send()).rejects.toThrow('bug');
  expect(f.messages).toEqual([]);
});

it('[BR-ID-05] a definite rejection releases the reservation and answers 50001, even when the release fails', async () => {
  const rejecting: SmsSender = { send: async () => 'rejected' };
  const afterAccepted = vi.fn(async () => undefined);
  const ok = setup({ sender: rejecting, hooks: { afterAccepted } });
  expect(await ok.send()).toEqual({ code: 50001 });
  expect(ok.calls.map((call) => call.kind)).toEqual(['reserve', 'release']);
  expect(ok.calls[1]!.options.keys).toEqual(ok.calls[0]!.options.keys);
  expect(afterAccepted).not.toHaveBeenCalled();

  const failing = setup({
    sender: rejecting,
    reply: (kind) => {
      if (kind === 'release') throw new RedisUnavailableError('command_timeout');
      return [1, 0];
    },
  });
  expect(await failing.send()).toEqual({ code: 50001 });
  expect(failing.lines.join('')).toContain('sms_release_failed');
});

const throwing: SmsSender = {
  send: async () => {
    throw new Error('socket hang up');
  },
};
const odd: SmsSender = { send: async () => 'queued' as never };
const unknown: SmsSender = { send: async () => 'unknown' };

it.each([
  ['throws', throwing],
  ['answers something else', odd],
  ['answers unknown', unknown],
] as const)(
  '[BR-ID-05] a sender that %s counts as sent: confirmed, code stored, 0',
  async (_name, sender) => {
    const afterAccepted = vi.fn(async () => undefined);
    const f = setup({ sender, hooks: { afterAccepted } });
    expect((await f.send()).code).toBe(0);
    expect(f.calls.map((call) => call.kind)).toEqual(['reserve', 'confirm', 'store']);
    expect(afterAccepted).toHaveBeenCalledTimes(1);
    expect(f.lines.join('')).not.toContain('socket hang up');
  },
);

it('[BR-ID-05] the 60-second window and the code lifetime start when the provider answered', async () => {
  let providerAnswers = (): void => undefined;
  const slow = setup({
    sender: {
      send: async () => {
        providerAnswers();
        return 'accepted';
      },
    },
  });
  providerAnswers = () => slow.clock.advanceMs(30_000);
  expect((await slow.send()).code).toBe(0);
  const accepted = String(new Date(START).getTime() + 30_000);
  expect(slow.calls[0]!.options.args[0]).toBe(String(new Date(START).getTime()));
  expect(slow.calls[1]!.options.args[0]).toBe(accepted);
  expect(slow.calls[2]!.options.args[1]).toBe(accepted);
});

it('[BR-ID-05] a store failure after the SMS went out answers 50001, and the post-acceptance counter still runs', async () => {
  const afterAccepted = vi.fn(async () => undefined);
  const f = setup({
    hooks: { afterAccepted },
    reply: (kind) => {
      if (kind === 'confirm') throw new RedisUnavailableError('command_failed', 'OOM');
      return [1, 0];
    },
  });
  expect(await f.send()).toEqual({ code: 50001 });
  expect(afterAccepted).toHaveBeenCalledTimes(1);
  expect(f.lines.join('')).toContain('sms_code_store_failed');
});

it('[BR-ID-05] a malformed sms.blocked_prefixes keeps the 08 default and logs the key, not the value', async () => {
  const f = setup({ config: { prefixes: ['+86139'] } });
  expect(await f.send('17012345678')).toEqual({ code: 44001, kind: 'blocked_prefix' });
  expect(await f.send()).toMatchObject({ code: 0 });
  expect(f.configValue).toHaveBeenCalledWith('couli', 'sms.blocked_prefixes');
  const warning = f.lines.find((line) => line.includes('sms_config_invalid'));
  expect(warning).toContain('"config_version":3');
  expect(warning).not.toContain('+86139');
});

it('[BR-ID-05] verifyAndConsume maps the script answers and never hashes a value that cannot be a code', async () => {
  const answers = [0, 2, 3];
  const f = setup({ reply: (kind) => (kind === 'verify' ? answers.shift() : 1) });
  const verify = (code: string, phone = NUMBER) =>
    f.service.verifyAndConsume({ app_id: 'couli', phone, purpose: 'bind', code });
  expect(await verify('123456', `+86 ${NUMBER}`)).toEqual({ code: 0 });
  expect(await verify('123456')).toEqual({ code: 20002 });
  expect(await verify('123456')).toEqual({ code: 20003 });
  expect(f.calls.every((call) => call.options.keys[0]!.startsWith('c:couli:bind:'))).toBe(true);
  expect(new Set(f.calls.map((call) => call.options.keys[0])).size).toBe(1);

  f.hmac.mockClear();
  answers.push(2);
  expect(await verify('12345a')).toEqual({ code: 20002 });
  expect(f.calls.at(-1)!.options.args[0]).toBe('');
  expect(f.hmac.mock.calls.some(([text]) => text.includes('12345a'))).toBe(false);

  const before = f.calls.length;
  expect(await verify('123456', '+852 5123 4567')).toEqual({ code: 20003 });
  expect(f.calls).toHaveLength(before);
});

it('[BR-ID-05] an unexpected script answer is a Redis failure, not a verdict', async () => {
  const f = setup({ reply: () => 'OK' });
  await expect(
    f.service.verifyAndConsume({
      app_id: 'couli',
      phone: NUMBER,
      purpose: 'login',
      code: '123456',
    }),
  ).rejects.toBeInstanceOf(RedisUnavailableError);
  expect(await f.send()).toEqual({ code: 42901, retryAfterSec: 5 });
});
