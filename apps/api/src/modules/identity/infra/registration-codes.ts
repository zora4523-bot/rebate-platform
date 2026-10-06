// Default candidate sources of the codes a new account gets (BR-INV-01 invite_code, BR-ATTR-06
// attr_code): every character drawn uniformly from the system CSPRNG (`randomInt` of node:crypto
// rejects out-of-range draws, so there is no modulo bias).
//
// Also compiled by the `test` project: erasable syntax only, `.ts` relative imports, no decorators.
import { randomInt } from 'node:crypto';
import {
  ATTR_CODE_ALPHABET,
  ATTR_CODE_LENGTH,
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
} from '../domain/registration.ts';

function draw(alphabet: string, length: number): string {
  let code = '';
  for (let index = 0; index < length; index++) code += alphabet[randomInt(alphabet.length)];
  return code;
}

/** A new invite-code candidate: 6 characters of 23456789ABCDEFGHJKLMNPQRSTUVWXYZ. */
export function newInviteCode(): string {
  return draw(INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH);
}

/** A new attr_code candidate: 8 characters of [0-9a-z]. */
export function newAttrCode(): string {
  return draw(ATTR_CODE_ALPHABET, ATTR_CODE_LENGTH);
}
