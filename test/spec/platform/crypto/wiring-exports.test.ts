// Rule tests: what apps/api/src/modules/platform/index.ts (the module's only public surface,
// apps/api/AGENTS.md「index.ts 是模块唯一的对外出口」) exports of crypto and http, §5 of
// apps/api/src/modules/platform/crypto/startup.ts (规划/08 BR-ID-33; ADR-0001 §2 鉴权与密钥;
// 规划/02 §6.2 治理层). Other tasks add exports to the same file, so only the names of this
// contract are checked: present ones must be the very values of crypto/index.ts and
// http/index.ts, the key-handling functions must stay inside the platform module.
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import * as crypto from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import * as http from '../../../../apps/api/src/modules/platform/http/index.ts';
import { platformIndex } from './wiring-kit.ts';

// Starting Nest (and loading it the first time) is slow on CI runners, several times slower than
// on a workstation: an explicit timeout keeps the default 5 s from failing a correct entry.
const NEST_TIMEOUT_MS = 30_000;

it(
  '[BR-ID-33][ADR-0001 §2] platform/index.ts 导出 FIELD_CRYPTO 令牌（Symbol，描述为 FIELD_CRYPTO）',
  async () => {
    const index = await platformIndex();
    const token = index['FIELD_CRYPTO'];
    expect(typeof token).toBe('symbol');
    expect(typeof token === 'symbol' ? token.description : token).toBe('FIELD_CRYPTO');
  },
  NEST_TIMEOUT_MS,
);

it(
  '[BR-ID-33] platform/index.ts 导出 crypto 的 FieldCryptoError 与 FIELD_CRYPTO_MESSAGES（同一个值）',
  async () => {
    const index = await platformIndex();
    expect({
      FieldCryptoError: index['FieldCryptoError'] === crypto.FieldCryptoError,
      FIELD_CRYPTO_MESSAGES: index['FIELD_CRYPTO_MESSAGES'] === crypto.FIELD_CRYPTO_MESSAGES,
    }).toEqual({ FieldCryptoError: true, FIELD_CRYPTO_MESSAGES: true });
  },
  NEST_TIMEOUT_MS,
);

it(
  '[规划/02 §6.2] platform/index.ts 导出 http 的全部运行时名字（同一个值）',
  async () => {
    const index = await platformIndex();
    const names = Object.keys(http).sort();
    expect(names).toEqual([
      'GovernanceError',
      'createGovernor',
      'createMemoryQuotaLimiter',
      'quotaShares',
      'systemScheduler',
      'unionPolicy',
    ]);
    const same = Object.fromEntries(
      names.map((name) => [name, index[name] === (http as Record<string, unknown>)[name]]),
    );
    expect(same).toEqual(Object.fromEntries(names.map((name) => [name, true])));
  },
  NEST_TIMEOUT_MS,
);

it(
  '[BR-ID-33][ADR-0001 §2] 打开与改写 keyring 的函数不出 platform 模块：index.ts 不导出它们',
  async () => {
    const index = await platformIndex();
    const forbidden = [
      'LocalKeyProvider',
      'createWrappedKeyring',
      'rotateDataKey',
      'openFieldCrypto',
      'openConfiguredFieldCrypto',
      'readKeyringConfig',
    ];
    // The module itself must load and export the token, or the absence below proves nothing.
    expect(typeof index['FIELD_CRYPTO']).toBe('symbol');
    expect(forbidden.filter((name) => Object.hasOwn(index, name))).toEqual([]);
  },
  NEST_TIMEOUT_MS,
);
