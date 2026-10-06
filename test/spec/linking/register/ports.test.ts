import { expect, it } from 'vitest';
import {
  createGuestCallerContext,
  createUnavailableAttrCodeReader,
} from '../../../../apps/api/src/modules/linking/index.ts';
import { DEVICE_A, USER_A, USER_B } from './kit.ts';

it('[AC-B1-06c#1] 未接 identity 时忽略输入身份，每次只返回应用与设备范围内的游客', async () => {
  const scope = { appId: 'register-app', deviceId: DEVICE_A, userId: USER_A };
  const context = createGuestCallerContext(scope);
  const first = await context.current();
  expect(first).toEqual({ appId: 'register-app', deviceId: DEVICE_A, userId: null });
  scope.userId = USER_B;
  expect(await context.current()).toEqual({
    appId: 'register-app',
    deviceId: DEVICE_A,
    userId: null,
  });
});

it('[AC-B1-06c#2] 未接 attr_code 查询时所有应用与用户均不可用，不回退 user_id', async () => {
  const reader = createUnavailableAttrCodeReader();
  expect(await reader.attrCode('register-app', USER_A)).toBeNull();
  expect(await reader.attrCode('other-app', USER_B)).toBeNull();
});
