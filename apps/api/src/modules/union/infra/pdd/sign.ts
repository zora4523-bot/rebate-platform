/** Values absent from a request are omitted by the caller, not signed as null/undefined. */
export type PddParameter =
  string | number | boolean | readonly unknown[] | Readonly<Record<string, unknown>>;
export type PddParameters = Readonly<Record<string, PddParameter>>;

// TODO(规划/11 §4.5): 数组参数序列化 — blocked on CAP-PDD probe 核对
/** ASCII key order, excluding sign; structured values use compact JSON strings. */
export function signPddParameters(parameters: PddParameters, clientSecret: string): string {
  void parameters;
  void clientSecret;
  throw new Error('NotImplemented: signPddParameters');
}
