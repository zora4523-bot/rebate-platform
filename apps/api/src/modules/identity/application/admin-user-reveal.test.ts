import { randomInt } from 'node:crypto';
import { expect, it } from 'vitest';
import type { AuditInput, FieldCrypto } from '../../platform/index.ts';
import { maskPhone } from '../domain/mask-phone.ts';
import {
  AdminRevealFieldsError,
  AdminUserReveal,
  type AdminRevealCommand,
  type AdminRevealStore,
} from './admin-user-reveal.ts';
import { PHONE_CIPHER_CONTEXT } from './registration.ts';

const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';
// Synthetic number generated per run; no phone-shaped literal in the fixture (BR-ID-33).
const PHONE = `138${String(randomInt(100_000_000)).padStart(8, '0')}`;
const COMMAND: AdminRevealCommand = {
  appId: 'app-a',
  adminId: 'admin-1',
  ip: '127.0.0.1',
  userId: USER,
  field: 'phone',
  reason: '核对',
};

function harness(options: { cipher?: Uint8Array | null; missing?: boolean; failAudit?: boolean }) {
  const events: string[] = [];
  const audits: AuditInput[] = [];
  const reads: { appId: string; userId: string }[] = [];
  const store: AdminRevealStore = {
    phoneCipher(input) {
      reads.push(input);
      events.push('read');
      if (options.missing === true) return Promise.resolve(undefined);
      return Promise.resolve({
        phoneCipher: options.cipher === undefined ? Buffer.from('envelope') : options.cipher,
      });
    },
  };
  const crypto = {
    decrypt(ciphertext: string, context: string): string {
      events.push('decrypt');
      if (ciphertext !== 'envelope' || context !== PHONE_CIPHER_CONTEXT) {
        throw new Error('decryption failed');
      }
      return PHONE;
    },
  } as unknown as FieldCrypto;
  const service = new AdminUserReveal({
    store,
    crypto,
    audit: {
      append(input) {
        events.push('audit');
        audits.push(input);
        return options.failAudit === true
          ? Promise.reject(new Error('audit down'))
          : Promise.resolve();
      },
    },
  });
  return { service, events, audits, reads };
}

it('[AC-F1-07a-U#1] decrypts, audits without the value, then returns the phone', async () => {
  const h = harness({});
  await expect(h.service.reveal(COMMAND)).resolves.toBe(PHONE);
  expect(h.events).toEqual(['read', 'decrypt', 'audit']);
  expect(h.reads).toEqual([{ appId: 'app-a', userId: USER }]);
  expect(h.audits).toEqual([
    {
      appId: 'app-a',
      actor: 'admin-1',
      action: 'user_pii_reveal',
      target: USER,
      before: null,
      after: { user_id: USER, field: 'phone', reason: '核对' },
      ip: '127.0.0.1',
    },
  ]);
  expect(JSON.stringify(h.audits)).not.toContain(PHONE);
});

it('[AC-F1-07a-U#2] an unknown user is 20001 [user_id] and nothing is audited', async () => {
  const h = harness({ missing: true });
  const error = await h.service.reveal(COMMAND).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AdminRevealFieldsError);
  expect((error as AdminRevealFieldsError).fields).toEqual(['user_id']);
  expect(h.audits).toEqual([]);
});

it('[AC-F1-07a-U#3] a user without a phone is 20001 [field] and nothing is audited', async () => {
  const h = harness({ cipher: null });
  const error = await h.service.reveal(COMMAND).catch((e: unknown) => e);
  expect((error as AdminRevealFieldsError).fields).toEqual(['field']);
  expect(h.events).toEqual(['read']);
});

it('[AC-F1-07a-U#4] a damaged cipher or a failed audit rejects without a value', async () => {
  const broken = harness({ cipher: Buffer.from('broken') });
  await expect(broken.service.reveal(COMMAND)).rejects.toThrow('decryption failed');
  expect(broken.audits).toEqual([]);
  const down = harness({ failAudit: true });
  await expect(down.service.reveal(COMMAND)).rejects.toThrow('audit down');
});

it('[AC-F1-07a-U#5] maskPhone keeps 3 + 4 of a mainland mobile and hides everything else', () => {
  expect(maskPhone(PHONE)).toBe(`138****${PHONE.slice(-4)}`);
  expect(maskPhone(`+86${PHONE}`)).toBe('*'.repeat(14));
  expect(maskPhone('')).toBe('');
});
