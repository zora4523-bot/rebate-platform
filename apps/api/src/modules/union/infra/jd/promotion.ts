// 京东转链接口（jd.union.open.promotion.common.get，B1-04zd）的请求参数。
// 规则测试：test/spec/union/jd-convert/**。
import type { ConvertReq, UnionIdentity } from '../../domain/types.ts';

/**
 * item 模式下一次转链的 promotionCodeReq：materialId、siteId、positionId、sceneId，身份有 subUnionId
 * 时原样带上。身份不合 invalid_identity，商品不合 invalid_dto。
 */
export function jdPromotionCodeReq(
  req: ConvertReq,
  identity: UnionIdentity,
  siteId: string,
): Readonly<Record<string, unknown>> {
  void req;
  void identity;
  void siteId;
  throw new Error('NotImplemented: jdPromotionCodeReq');
}
