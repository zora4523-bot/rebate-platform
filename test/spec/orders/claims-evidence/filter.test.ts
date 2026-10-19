import { it } from 'vitest';
import { check, log, at } from './kit.ts';
import type { ClaimEvidenceLog } from '../../../../apps/api/src/modules/linking/index.ts';

it('[AC-B1-10c#1] BR-ATTR-18 例、AC-S1-26-TB①：10-12同商品open对应10-20付款为strong', async () => {
  await check({}, 'strong', ['101']);
});
it('[AC-B1-10c#2] BR-ATTR-18 例：10-01的同商品记录超过360小时为none', async () => {
  await check({ logs: [log({ created_at: at('2027-10-01T12:00:00.000Z') })] }, 'none', []);
});
it('[AC-B1-10c#3] 同商品convert成功也为strong', async () => {
  await check({ logs: [log({ event: 'convert' })] }, 'strong', ['101']);
});
const excluded: [string, Partial<ClaimEvidenceLog>][] = [
  ['precompute', { event: 'precompute' }],
  ['register', { event: 'register' }],
  ['失败', { result_code: 30151 }],
  ['其他平台', { platform: 'pdd' }],
  ['其他人', { user_id: 'other' }],
  ['其他App', { app_id: 'other' }],
  ['仅opener是申请人', { user_id: 'other', opener_user_id: 'applicant' }],
  ['匿名创建者', { user_id: null, opener_user_id: 'applicant' }],
  ['未知平台', { platform: null }],
];
it.each(excluded)('[AC-B1-10c#4] %s的同商品记录按不存在处理', async (_name, patch) => {
  await check({ logs: [log(patch)] }, 'none', []);
});
it.each(['share', 'service', 'unknown', null])(
  '[AC-B1-10c#5] 不按pid_scene=%s过滤',
  async (pid_scene) => {
    await check({ logs: [log({ pid_scene, cache_hit: true, expired: true })] }, 'strong', ['101']);
  },
);
it('[AC-B1-10c#6] 无同商品但同店其他商品为weak', async () => {
  await check({ logs: [log({ product_key: 'tb:456' })] }, 'weak', ['101']);
});
it('[AC-B1-10c#7] 无同店但同平台其他商品仍为weak', async () => {
  await check({ logs: [log({ product_key: 'tb:456', shop_id: 'other' })] }, 'weak', ['101']);
});
it.each([null, ''])('[AC-B1-10c#8] 订单商品键缺失%s不能空值相等升级strong', async (productKey) => {
  await check({ productKey, logs: [log({ product_key: productKey })] }, 'weak', ['101']);
});
it('[AC-B1-10c#9] 无记录none的引用必须为空数组', async () => {
  await check({ logs: [] }, 'none', []);
});
it('[AC-B1-10c#10] 被过滤的strong不遮蔽有效weak', async () => {
  await check(
    { logs: [log({ result_code: 30151 }), log({ id: '102', product_key: 'tb:456' })] },
    'weak',
    ['102'],
  );
});
