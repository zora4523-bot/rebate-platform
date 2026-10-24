import { expect } from 'vitest';
import type { Response } from '../auth/kit.ts';
import { error, type Code, type Operation } from '../admins-verify-phone/kit.ts';

export {
  harness,
  mask,
  ok,
  setup,
  testPhone,
  text,
  type Account,
  type Setup,
  type VerifyPhone,
} from '../admins-verify-phone/kit.ts';

/** The super admin's reason on the change route (1–200 characters). */
export const REASON = '本人委托代改，已视频核对本人身份';

/**
 * A code submitted on a route other than the one it was sent on is not this route's pending code:
 * the contract's code refusal (20002 wrong code, or 20003 no pending code for this submission),
 * without data. The contract does not say which of the two (B1-34o ledger note), so both pass.
 */
export async function refused(response: Response, operation: Operation) {
  expect(response.statusCode).toBe(400);
  const code = response.json().code;
  expect([20002, 20003]).toContain(code);
  await error(response, operation, code as Code);
}
