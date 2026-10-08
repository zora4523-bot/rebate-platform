import { expect, it } from 'vitest';
import {
  createIdentityCallerContext,
  createIdentityViewerContext,
  type IdentityRequest,
} from '../../../../apps/api/src/modules/identity/ports/request-context.ts';

const principal = {
  uid: '019a0000-0000-7000-8000-000000000011',
  app_id: 'couli',
  sid: 'verified-session',
  device_id: '019a0000-0000-7000-8000-000000000012',
  scp: 'full' as const,
};

for (const [name, createContext] of [
  ['ViewerContext', createIdentityViewerContext],
  ['CallerContext', createIdentityCallerContext],
] as const) {
  it(`[AC-B1-02m#1] ${name} 只认已验证令牌的三个身份字段`, async () => {
    // Deliberately conflicting carriers pin precedence. Cross-app rejection belongs to the
    // real HTTP guard, tested separately; this port must not reinterpret X-App-Id as identity.
    const request = {
      principal,
      verifiedDevice: { appId: 'couli_other', deviceId: 'signed-device' },
      headers: { 'x-app-id': 'couli_other', 'x-device-id': 'header-device', 'x-user-id': 'fake' },
      body: { app_id: 'fake', user_id: 'fake', device_id: 'fake', attr_code: 'fake' },
      query: { app_id: 'fake', user_id: 'fake', device_id: 'fake' },
    };
    expect(await createContext(request).current()).toEqual({
      appId: principal.app_id,
      userId: principal.uid,
      deviceId: principal.device_id,
    });
  });

  it(`[AC-B1-02m#2] ${name} 匿名签名请求只取已验证设备`, async () => {
    const request = {
      headers: {
        'x-app-id': 'couli_other',
        'x-device-id': 'unverified',
        'x-user-id': principal.uid,
      },
      verifiedDevice: { appId: 'couli', deviceId: principal.device_id },
      body: { user_id: principal.uid },
    };
    expect(await createContext(request).current()).toEqual({
      appId: 'couli',
      userId: null,
      deviceId: principal.device_id,
    });
  });

  it(`[AC-B1-02m#3] ${name} 无凭证时保留 App 游客回退，不信任裸设备头或身份参数`, async () => {
    const request = {
      headers: {
        'x-app-id': 'couli',
        'x-device-id': principal.device_id,
        'x-user-id': principal.uid,
      },
      body: { user_id: principal.uid, device_id: principal.device_id },
    };
    expect(await createContext(request).current()).toEqual({
      appId: 'couli',
      userId: null,
      deviceId: null,
    });
  });

  it(`[AC-B1-02m#4] ${name} 交错读取不同用户和游客时不会串用上一个请求的身份`, async () => {
    const requests: IdentityRequest[] = [
      { headers: { 'x-app-id': 'couli' }, principal },
      {
        headers: { 'x-app-id': 'couli_other' },
        principal: { ...principal, app_id: 'couli_other', uid: 'user-b', device_id: 'device-b' },
      },
      { headers: { 'x-app-id': 'couli' } },
    ];
    const contexts = requests.map(createContext);
    const expected = [
      { appId: 'couli', userId: principal.uid, deviceId: principal.device_id },
      { appId: 'couli_other', userId: 'user-b', deviceId: 'device-b' },
      { appId: 'couli', userId: null, deviceId: null },
    ];
    for (const index of [0, 1, 2, 1, 0, 2]) {
      expect(await contexts[index]!.current()).toEqual(expected[index]);
    }
  });
}
