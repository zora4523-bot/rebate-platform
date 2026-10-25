import { expect, it } from 'vitest';
import {
  DATA_COPY_CODE_ALPHABET,
  dataCopyFileEntries,
  encryptDataCopyZip,
  generateDataCopySecret,
  openSealedDataCopyEntries,
  sealDataCopyEntries,
  type PersonalDataCopyContent,
} from './data-copy-file.ts';

const AT = new Date(Date.parse('2026-11-02T02:00:00.000Z'));

const CONTENT: PersonalDataCopyContent = {
  account: { nickname: '小狸', phone: null, login_providers: [], registered_at: AT },
  realname: { status: 'none', masked_name: null, masked_id_no: null, verified_at: null },
  consents: [],
  orders: [],
  ledger: [
    {
      ledger_type: 'REBATE_CREDIT',
      sub_type: null,
      sub_account: 'available',
      amount_fen: -5n,
      balance_after_fen: null,
      booked_at: AT,
    },
  ],
  withdrawals: [],
  agent: [],
  invite: { has_inviter: false },
};

/** A sealing stand-in: reversible, context-checked. */
const crypto = {
  encrypt: (plain: string, context: string) => `${context}|${Buffer.from(plain).toString('hex')}`,
  decrypt: (cipher: string, context: string) => {
    const [given, hex] = cipher.split('|');
    if (given !== context || hex === undefined) throw new Error('wrong context');
    return Buffer.from(hex, 'hex').toString('utf8');
  },
};

it('[AC-B1-27h] the secret is 12 characters of the unambiguous alphabet', () => {
  for (let i = 0; i < 50; i += 1) {
    expect(generateDataCopySecret()).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);
  }
});

it('[AC-B1-27h] the entries are fixed plain names; bigint fen are decimal strings', () => {
  const entries = dataCopyFileEntries(CONTENT);
  expect(entries.map((entry) => entry.name)).toEqual([
    'README.txt',
    'account.json',
    'realname.json',
    'consents.json',
    'orders.json',
    'ledger.json',
    'withdrawals.json',
    'agent_conversations.json',
    'invite.json',
  ]);
  const ledger = entries.find((entry) => entry.name === 'ledger.json')!;
  expect(JSON.parse(Buffer.from(ledger.bytes).toString('utf8'))).toEqual([
    expect.objectContaining({ amount_fen: '-5', booked_at: AT.toISOString() }),
  ]);
});

it('[AC-B1-27h] the archive ends with one central directory naming every entry', () => {
  const entries = dataCopyFileEntries(CONTENT);
  const zip = Buffer.from(encryptDataCopyZip(entries, 'synthetic-password'));
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  expect(zip.readUInt16LE(end + 10)).toBe(entries.length);
  expect(() => encryptDataCopyZip(entries, '')).toThrow(TypeError);
  expect(() => encryptDataCopyZip([{ name: '../x', bytes: new Uint8Array() }], 'p')).toThrow(
    TypeError,
  );
});

it('[AC-B1-27h] a sealed copy opens to the same entries and refuses malformed input', () => {
  const entries = dataCopyFileEntries(CONTENT);
  const sealed = sealDataCopyEntries(entries, crypto);
  expect(openSealedDataCopyEntries(sealed, crypto)).toEqual(entries);
  const forged = new Uint8Array(
    Buffer.from(crypto.encrypt('{"v":2,"entries":[]}', 'personal_data_copies.file')),
  );
  expect(() => openSealedDataCopyEntries(forged, crypto)).toThrow(TypeError);
});

it('the extraction-code alphabet is A–Z without I and O, then 2–9: 32 distinct characters', () => {
  expect(DATA_COPY_CODE_ALPHABET).toHaveLength(32);
  expect(new Set(DATA_COPY_CODE_ALPHABET).size).toBe(32);
  const letters = 'ABCDEFGH' + 'JKLMN' + 'PQRSTUVWXYZ';
  const digits = '2345' + '6789';
  expect(DATA_COPY_CODE_ALPHABET).toBe(letters + digits);
  for (const lookAlike of ['I', 'O', '0', '1']) {
    expect(DATA_COPY_CODE_ALPHABET).not.toContain(lookAlike);
  }
  expect(generateDataCopySecret()).toMatch(new RegExp(`^[${DATA_COPY_CODE_ALPHABET}]{12}$`));
});
