/** ASCII key ordering, unescaped values; omit the signature and empty values, retain sign_type=RSA2. */
export function canonicalAlipayParams(params: Readonly<Record<string, string>>): string {
  void params;
  throw new Error('NotImplemented: canonicalAlipayParams');
}

export function signAlipayParams(
  params: Readonly<Record<string, string>>,
  privateKey: string,
): string {
  void params;
  void privateKey;
  throw new Error('NotImplemented: signAlipayParams');
}

/** Verify the original response node bytes, never a parsed-and-reserialized object. */
export function verifyAlipayResponse(
  responseNode: string,
  signature: string,
  publicKey: string,
): boolean {
  void responseNode;
  void signature;
  void publicKey;
  throw new Error('NotImplemented: verifyAlipayResponse');
}
