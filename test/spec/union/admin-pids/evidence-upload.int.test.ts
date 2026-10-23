import { afterEach, expect, it, vi } from 'vitest';
import { HjyIgnoreEvidenceStore } from '../../../../apps/api/src/modules/union/infra/hjy-ignore-evidence-store.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import { JPEG, PNG } from './image-fixtures.ts';
import { accepted, bodyFor, current, rejected, seedPid, setup, snapshot } from './kit.ts';

const h = useHarness();
afterEach(() => vi.restoreAllMocks());

// Only the external storage write is replaced. HTTP multipart parsing, authorization,
// step-up, byte inspection, PID service and database transactions remain real.
function captureStorage() {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const put = vi
    .spyOn(HjyIgnoreEvidenceStore.prototype, 'put')
    .mockImplementation(async (input) => {
      objects.set(input.key, {
        bytes: Buffer.from(input.bytes),
        contentType: input.contentType,
      });
    });
  return { objects, put };
}

it.each([
  ['WebP', Buffer.from('RIFF\x04\x00\x00\x00WEBP', 'binary')],
  ['HEIC', Buffer.from('000000186674797068656963000000006d69663168656963', 'hex')],
  ['随机字节', Buffer.from('a713b942058ef0c36d219a745be608df', 'hex')],
] as const)(
  '[AC-B1-22h#47] 声明 image/png 但实际为 %s 时拒绝，不修改行或保存文件',
  async (_format, bytes) => {
    const storage = captureStorage();
    const s = await setup(h);
    const row = await seedPid(s);
    const before = await snapshot(s);
    await rejected(
      await s.write('activate', row.id, bodyFor('activate', row), {
        file: { bytes, contentType: 'image/png', filename: 'hjy.png' },
      }),
      20001,
      { fields: ['hjy_ignore_evidence'] },
    );
    expect(await snapshot(s)).toEqual(before);
    expect(await current(s, row.id)).toMatchObject({
      status: 'pending',
      hjy_ignore_confirmed_at: null,
      hjy_ignore_evidence_path: null,
    });
    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.objects.size).toBe(0);
  },
);

it.each([
  ['PNG', PNG, 'image/png', 'hjy.png'],
  ['JPEG', JPEG, 'image/jpeg', 'hjy.jpg'],
] as const)(
  '[AC-B1-22h#48] 成功启用的 %s 对象路径与写库一致，存储字节与上传逐字节相等',
  async (_format, bytes, contentType, filename) => {
    const storage = captureStorage();
    const s = await setup(h);
    const row = await seedPid(s);
    const uploaded = Buffer.from(bytes);
    const data = await accepted(
      await s.write('activate', row.id, bodyFor('activate', row), {
        file: { bytes: uploaded, contentType, filename },
      }),
    );
    const storedRow = await current(s, row.id);
    expect(data.status).toBe('active');
    expect(storedRow.status).toBe('active');
    expect(storedRow.hjy_ignore_evidence_path).toBe(data.hjy_ignore_evidence_path);
    expect(storedRow.hjy_ignore_evidence_path).toEqual(expect.any(String));
    expect(storedRow.hjy_ignore_evidence_path).not.toBe('');
    expect(storedRow.hjy_ignore_evidence_path).not.toMatch(/^https?:\/\//);
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(storage.objects.size).toBe(1);
    const object = storage.objects.get(storedRow.hjy_ignore_evidence_path!);
    expect(object).toBeDefined();
    expect(object?.contentType).toBe(contentType);
    expect(object?.bytes).toEqual(uploaded);
  },
);
