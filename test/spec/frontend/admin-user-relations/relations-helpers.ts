import { act, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import {
  button,
  click,
  detailLoaded,
  dialog,
  lookup,
  mainElement,
  mount,
  openDetail,
  SUPER,
  verify,
} from '../admin-users/helpers.ts';
import { card, required } from '../admin-users-visual/helpers.ts';
import { CHANGE_REASON, NEW_PARENT, UID, createRelationsServer } from './relations-fixtures.ts';

export * from '../admin-users/helpers.ts';
export { card, required };
configure({ asyncUtilTimeout: 10_000 });
export const SAVE = /^(验证并保存|验证并继续|确认|保存|提交)$/;

export async function show(server = createRelationsServer(), snapshot: PermissionSnapshot = SUPER) {
  const mounted = await mount(server, snapshot, true);
  if (!snapshot.isSuper && !snapshot.permissions.includes('user.list')) await lookup(UID);
  else await openDetail();
  await detailLoaded();
  return { ...mounted, server };
}

export async function change(input: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
}
export function reasonInput(modal: HTMLElement): HTMLTextAreaElement {
  return required(
    within(modal).queryByRole('textbox', { name: /原因/ }),
    'labelled reason',
  ) as HTMLTextAreaElement;
}
export function inviterInput(modal: HTMLElement): HTMLInputElement {
  return required(
    within(modal).queryByRole('textbox', { name: /新上级|上级.*UID|邀请人/ }),
    'labelled inviter UID',
  ) as HTMLInputElement;
}
export async function openChange(kind: 'level' | 'inviter') {
  const name = kind === 'level' ? '调等级' : '改上级';
  const trigger = button(mainElement(), name);
  trigger.focus();
  await click(trigger);
  const modal = await dialog(name);
  return { trigger, modal };
}
export async function selectLevel(modal: HTMLElement, level = 'L3'): Promise<HTMLElement> {
  const input = required(
    within(modal).queryByRole('combobox', { name: /等级/ }),
    'labelled level selector',
  );
  await act(async () => {
    fireEvent.mouseDown(input);
  });
  const option = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content',
      ),
    ).find((node) => node.textContent?.trim() === level);
  await waitFor(() => expect(option(), `level option ${level}`).toBeDefined());
  await click(option()!);
  return input;
}
export async function fillChange(
  kind: 'level' | 'inviter',
  modal: HTMLElement,
  reason = CHANGE_REASON,
) {
  if (kind === 'level') await selectLevel(modal);
  else await change(inviterInput(modal), NEW_PARENT);
  await change(reasonInput(modal), reason);
}
export async function startVerification(modal: HTMLElement): Promise<HTMLElement> {
  await click(button(modal, SAVE));
  return dialog('二次验证 · 动态码');
}
export async function submitChange(modal: HTMLElement): Promise<void> {
  await verify(await startVerification(modal));
}
export async function drawer(): Promise<HTMLElement> {
  await click(button(mainElement(), '查看直推名单'));
  return dialog('直推名单');
}
export async function close(modal: HTMLElement): Promise<void> {
  // Both the title bar and footer may offer close controls; Escape dismisses this layer.
  await act(async () => {
    fireEvent.keyDown(modal, { key: 'Escape', code: 'Escape', keyCode: 27 });
  });
  await waitFor(() => expect(screen.queryAllByRole('dialog').includes(modal)).toBe(false));
}
export function disabled(buttonNode: HTMLElement): boolean {
  return buttonNode.hasAttribute('disabled') || buttonNode.getAttribute('aria-disabled') === 'true';
}
export function expectFieldError(input: HTMLElement | null, text: string): void {
  const item = required(
    required(input, 'field control').closest<HTMLElement>('.ant-form-item'),
    'antd field with adjacent error',
  );
  const error = required(
    item.querySelector<HTMLElement>('.ant-form-item-explain-error, [role="alert"]'),
    'field error is beside the control',
  );
  expect(error.textContent).toContain(text);
}
