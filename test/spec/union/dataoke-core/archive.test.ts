import { expect, it } from 'vitest';
import {
  isSensitiveParameter,
  requestSummary,
} from '../../../../apps/api/src/modules/union/infra/archive.ts';
import type { UnionTransportRequest } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  appKey,
  baseUrl,
  expectedSignRan,
  nonce,
  path,
  secret,
  sent,
  setup,
  timer,
  version,
} from './kit.ts';

// The archive summary keeps request parameters minus sensitive names (matched after lowercasing
// and removing `_` / `-`). appKey and *secret already match; signRan (→ signran) must match too.
// nonce, timer and version stay.

const signRan = expectedSignRan(appKey, timer, nonce, secret);

it('[AC-B1-04m#35] signRan is a sensitive parameter name in every spelling; nonce, timer and version are not', () => {
  for (const name of ['signRan', 'signran', 'SIGNRAN', 'sign_ran', 'sign-ran', 'Sign_Ran']) {
    expect(isSensitiveParameter(name), name).toBe(true);
  }
  for (const name of ['appKey', 'appSecret']) {
    expect(isSensitiveParameter(name), name).toBe(true);
  }
  for (const name of ['nonce', 'timer', 'version', 'pageSize', 'startTime']) {
    expect(isSensitiveParameter(name), name).toBe(false);
  }
});

it('[AC-B1-04m#36] the archive summary of a signed GET query or POST form keeps neither signRan nor appKey', () => {
  const parameters = new URLSearchParams({ appKey, version, timer, nonce, signRan, q: 'x' });
  const archive = { appId: 'app-synthetic', kind: 'order' };
  const get: UnionTransportRequest = {
    platform: 'taobao',
    method: 'GET',
    url: `${baseUrl}${path}?${parameters.toString()}`,
    headers: {},
    archive,
  };
  const post: UnionTransportRequest = {
    platform: 'taobao',
    method: 'POST',
    url: `${baseUrl}${path}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: parameters.toString(),
    archive,
  };
  for (const request of [get, post]) {
    const summary = requestSummary(request);
    expect(summary).toEqual({
      method: request.method,
      url: `${baseUrl}${path}`,
      params: { version, timer, nonce, q: 'x' },
    });
    expect(JSON.stringify(summary)).not.toContain(signRan);
    expect(JSON.stringify(summary)).not.toContain(appKey);
  }
});

it('[AC-B1-04m#37] requests the client sends summarise without signRan, appKey or the secret', async () => {
  const { client, transport } = setup();
  const archive = { appId: 'app-synthetic', kind: 'order' };
  await client.request('GET', path, { q: 'x' }, { version, archive });
  await client.request('POST', path, { q: 'x' }, { version, archive });

  for (const index of [0, 1]) {
    const request = sent(transport, index);
    const summary = requestSummary(request);
    expect(summary).toEqual({
      method: request.method,
      url: `${baseUrl}${path}`,
      params: { version, timer, nonce, q: 'x' },
    });
    const text = JSON.stringify(summary);
    for (const marker of [signRan, appKey, secret]) expect(text).not.toContain(marker);
  }
});
