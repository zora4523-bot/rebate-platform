export type ContractAuth = 'none' | 'optional' | 'login' | 'phone' | 'realname';

export interface AuthRoute {
  readonly method: string;
  readonly path: string;
  readonly auth: ContractAuth;
}

/** Build-time generated from every OpenAPI operation, including planned operations. */
export function contractAuthRoutes(): readonly AuthRoute[] {
  throw new Error('NotImplemented: contractAuthRoutes');
}

/** HEAD falls back to GET only when HEAD has no explicit contract operation. */
export function contractAuthOf(method: string, template: string): ContractAuth | undefined {
  void method;
  void template;
  throw new Error('NotImplemented: contractAuthOf');
}
