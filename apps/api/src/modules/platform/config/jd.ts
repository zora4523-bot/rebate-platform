// Jingdong live adapter credentials (B1-04ze). Skeleton of the rule-test round: only the shape the
// rule tests in test/spec/union/jd-live-wiring/ import.

export interface JdAppConfig {
  readonly appKey: string;
  /** Path of the node file whose content is app_secret (staging only). */
  readonly secretFile: string;
}
