import {
  AdminOperationGuard,
  type AdminActor,
  type AdminOperationInput,
  type AdminOperationResponse,
} from '../../platform/index.ts';

/** F1-06u: adapt the verified request and current profile to createAdminPermissionGuard. */
export class AdminOperationGuardImpl extends AdminOperationGuard {
  override run(
    input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse> {
    void input;
    void business;
    throw new Error('NotImplemented: AdminOperationGuardImpl.run');
  }
}
