// B3-03m · ACS3-HMAC-SHA256 (Aliyun OpenAPI V3 signature) for the content safety review
// (B3-06b createAliyunInputReview / createAliyunOutputReview). Since B1-12w (D10-315) the signer
// lives in platform (../../../platform/aliyun/acs3.ts) and is shared with notification's SendSms
// channel; this file re-exports the same function so the agent's wiring and behaviour are unchanged.
// TODO(规划/11 §6): 真实调用验证 — blocked on 负责人在 staging 放入阿里云内容安全 Key
export { createAliyunAcs3Signer } from '../../../platform/index.ts';
