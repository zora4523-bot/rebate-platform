// PATCH /admin/v1/users/{user_id}/profile (adminEditUserProfile; BR-ID-44 细则, BR-ID-39 细则「后台改
// 昵称」, B1-27b). Mounted only by IdentityAdminModule on the admin entry. The admin request check has
// verified the admin_token and the route schema the body before this runs; the operation guard
// checks the account, user.phone_change and its totp step-up, and consumes the step-up token only
// after a 200 with code 0. The answer is the user as GET /admin/v1/users/{user_id} returns it after
// the save (AdminUsers.detail), phone number masked.
import type { Schema } from '@couli/contracts-ts';
import type { AdminOperationGuard, CheckedRequest } from '../../../platform/index.ts';
import type { AdminProfileEdit } from '../../application/admin-profile-edit.ts';
import type { AdminUsers } from '../../application/admin-users.ts';

interface ProfileRequest extends CheckedRequest {
  readonly id: string;
  readonly ip?: string;
}

export class AdminUserProfileController {
  constructor(guard: AdminOperationGuard, profiles: AdminProfileEdit, users: AdminUsers) {
    void guard;
    void profiles;
    void users;
    throw new Error('NotImplemented: AdminUserProfileController');
  }

  edit(
    request: ProfileRequest,
    userId: string,
    body: Schema<'AdminUserProfileEditRequest'>,
  ): Promise<Schema<'AdminUserDetailResponse'>> {
    void request;
    void userId;
    void body;
    throw new Error('NotImplemented: AdminUserProfileController.edit');
  }
}
