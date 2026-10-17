// B1-08h：用户归属（BR-ATTR-06 / 07；流水线第 ② 步），只在 user_id 为空时执行。读端口只回原始行，
// 判定在 orders 的纯函数里。B1-08i 的未归因重跑复用本函数。
// - 京东 / 拼多多：解析 attr_code → users.findByAttrCode（本 App；不过滤 status，已注销用户照常归属，
//   待编排裁定 6）；解析失败或查不到 → 未归因，计 attr_param_invalid。
// - 淘宝：relation_id 为空 → attr_binding_miss；否则按 attr_at 时点取有效绑定：0 条 → miss；
//   多个不同用户 → 未归因、P1 告警（attr_binding_conflict），不计数。
import type { RegisteredPlatform, UnionOrderAttrParams } from '../../union/index.ts';
import { parseAttrCode, resolveBinding } from '../domain/attribution.ts';
import type { OrderPipelineDeps } from './pipeline-types.ts';

export type UserCounter = 'attr_param_invalid' | 'attr_binding_miss';

export type UserAttribution =
  | { readonly kind: 'attributed'; readonly user_id: string }
  | {
      readonly kind: 'unattributed';
      readonly user_id: null;
      /** Counter to increment on first import; null for a binding conflict (alert only). */
      readonly counter: UserCounter | null;
      readonly conflict: boolean;
    };

export interface AttributeUserInput {
  readonly appId: string;
  readonly platform: RegisteredPlatform;
  readonly unionAccountId: string;
  readonly params: UnionOrderAttrParams;
  readonly attrAt: Date;
}

const unattributed = (counter: UserCounter | null, conflict = false): UserAttribution => ({
  kind: 'unattributed',
  user_id: null,
  counter,
  conflict,
});

export async function attributeOrderUser(
  ports: Pick<OrderPipelineDeps, 'users' | 'bindings'>,
  input: AttributeUserInput,
): Promise<UserAttribution> {
  if (input.platform === 'taobao') {
    const relationId = input.params.relation_id;
    if (relationId === null || relationId === '') return unattributed('attr_binding_miss');
    const rows = await ports.bindings.findByRelation({
      appId: input.appId,
      unionAccountId: input.unionAccountId,
      relationId,
    });
    const decision = resolveBinding(rows, input.attrAt);
    if (decision.kind === 'matched') return { kind: 'attributed', user_id: decision.user_id };
    if (decision.kind === 'conflict') return unattributed(null, true);
    return unattributed('attr_binding_miss');
  }
  const attrCode = parseAttrCode(input.platform, input.params);
  if (attrCode === null) return unattributed('attr_param_invalid');
  const userId = await ports.users.findByAttrCode({ appId: input.appId, attrCode });
  if (userId === null) return unattributed('attr_param_invalid');
  return { kind: 'attributed', user_id: userId };
}
