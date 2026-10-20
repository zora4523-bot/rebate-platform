import { HttpException } from '@nestjs/common';
import { admin_permission } from '@couli/contracts-ts';
import { expect, it, vi } from 'vitest';
import {
  AdminOperationGuard,
  type AdminActor,
  type AdminOperationInput,
  type AdminOperationResponse,
} from '../../../platform/index.ts';
import { AdminDictReader } from '../../application/admin-dict-reader.ts';
import type { DictStore } from '../../application/dict-reader.ts';
import { AdminDictController } from './dict.controller.ts';

const APP = 'dict_read_ctrl';

class FakeGuard extends AdminOperationGuard {
  readonly calls: AdminOperationInput[] = [];
  refuse: number | null = null;

  override async run(
    input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse> {
    this.calls.push(input);
    if (this.refuse !== null) {
      throw new HttpException({ code: this.refuse, msg: 'refused', trace_id: 't' }, 403);
    }
    return business({ adminId: 'a', appId: APP, isSuper: false, loginName: 'viewer' });
  }
}

function fixture() {
  const guard = new FakeGuard();
  const snapshot = vi.fn<DictStore['snapshot']>(async () => ({ value: '1', rows: [] }));
  const reader = new AdminDictReader({ snapshot }, () => ({ 'admin_dict.s.OK': '正常' }), {
    warn: vi.fn(),
  });
  return { guard, snapshot, controller: new AdminDictController(guard, reader) };
}

it('[AC-F1-02zd#u12] 读取以全部权限点任一、只读守卫；app 取守卫给出的账号', async () => {
  const f = fixture();
  const response = await f.controller.read({ id: 'trace-1' } as never);
  expect(response).toEqual({
    code: 0,
    msg: '',
    data: { version: '1', items: { s: { OK: '正常' } } },
    trace_id: 'trace-1',
  });
  expect(f.guard.calls).toHaveLength(1);
  expect(f.guard.calls[0]).toMatchObject({ permission: admin_permission, readOnly: true });
  expect([...(f.guard.calls[0]!.permission as readonly string[])]).toEqual([...admin_permission]);
  expect(f.snapshot.mock.calls[0]![0]).toBe(APP);
});

it('[AC-F1-02zd#u13] 守卫拒绝原样抛出，不读字典', async () => {
  const f = fixture();
  f.guard.refuse = 10403;
  await expect(f.controller.read({ id: 'trace-2' } as never)).rejects.toBeInstanceOf(HttpException);
  expect(f.snapshot).not.toHaveBeenCalled();
});
