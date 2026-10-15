/** Trusted identity handed to a business module after its admin operation is authorised. */
export interface AdminActor {
  readonly adminId: string;
  readonly appId: string;
  readonly isSuper: boolean;
  readonly loginName: string;
}

export interface AdminOperationInput {
  readonly request: object;
  readonly permission: string;
  readonly operation?: string;
}

export interface AdminOperationResponse {
  readonly statusCode: number;
  readonly body: { readonly code: number; readonly data?: unknown };
}

/** F1-06u: the class itself is the Nest token; business modules import only platform. */
export abstract class AdminOperationGuard {
  run(
    input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse> {
    void input;
    void business;
    throw new Error('NotImplemented: AdminOperationGuard.run');
  }
}
