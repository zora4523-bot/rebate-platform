// @vitest-environment jsdom
import { createElement, useState, type ComponentType } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { Dialog, Sheet, type ModalProps } from '../../../../apps/h5/src/components/base/index.ts';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

async function openModal(Component: ComponentType<ModalProps>, options: Partial<ModalProps> = {}) {
  const user = userEvent.setup();
  const portalContainer = document.createElement('div');
  document.body.append(portalContainer);
  const onClose = vi.fn();
  const primary = vi.fn();
  const secondary = vi.fn();

  function Harness() {
    const [open, setOpen] = useState(false);
    return createElement(
      'div',
      null,
      createElement(
        'main',
        { 'aria-hidden': open ? 'true' : undefined, inert: open },
        createElement('button', { onClick: () => setOpen(true) }, 'Open fixture'),
        createElement('button', null, 'Background action'),
      ),
      createElement(
        Component,
        {
          title: 'Caller title',
          description: 'Caller description',
          closeLabel: 'Caller close',
          primaryAction: { label: 'Caller confirm', onClick: primary },
          secondaryAction: { label: 'Caller cancel', onClick: secondary },
          ...options,
          open,
          portalContainer,
          onClose: () => {
            onClose();
            setOpen(false);
          },
        },
        createElement('label', null, 'Caller field', createElement('input')),
        createElement('button', { disabled: true }, 'Disabled action'),
        createElement('button', { style: { display: 'none' } }, 'Hidden action'),
      ),
    );
  }

  const view = render(createElement(Harness));
  const opener = screen.getByRole('button', { name: 'Open fixture' });
  await user.click(opener);
  return { ...view, user, opener, portalContainer, onClose, primary, secondary };
}

function part(container: ParentNode, name: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  expect(element, `missing part: ${name}`).not.toBeNull();
  return element!;
}

for (const Component of [Dialog, Sheet]) {
  const name = Component.name;

  it(`[AC-F1-01f-MODAL#1] ${name} 模态语义、标题及说明关联、DOM 顺序与标题焦点`, async () => {
    const { portalContainer } = await openModal(Component);
    const modal = screen.getByRole('dialog', {
      name: 'Caller title',
      description: 'Caller description',
    });
    const content = within(modal);
    const title = content.getByRole('heading', { name: 'Caller title' });
    const close = content.getByRole('button', { name: 'Caller close' });
    const body = part(modal, 'modal-body');
    const actions = part(modal, 'modal-actions');
    const secondary = content.getByRole('button', { name: 'Caller cancel' });
    const primary = content.getByRole('button', { name: 'Caller confirm' });
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(title.id).not.toBe('');
    expect(modal.getAttribute('aria-labelledby')).toBe(title.id);
    const descriptionId = modal.getAttribute('aria-describedby');
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId!)?.textContent).toBe('Caller description');
    expect(title.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(title);
    expect(portalContainer.contains(modal)).toBe(true);
    expect(modal.closest('[inert], [aria-hidden="true"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Background action' })).toBeNull();
    expect(body.contains(content.getByRole('textbox', { name: 'Caller field' }))).toBe(true);
    for (const [before, after] of [
      [title, close],
      [close, body],
      [body, actions],
      [secondary, primary],
    ] as const) {
      expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    }
    expect(actions.contains(secondary)).toBe(true);
    expect(actions.contains(primary)).toBe(true);
  });

  it(`[AC-F1-01f-MODAL#2] ${name} Tab 正反循环，跳过禁用与隐藏按钮`, async () => {
    const { user } = await openModal(Component);
    const close = screen.getByRole('button', { name: 'Caller close' });
    const field = screen.getByRole('textbox', { name: 'Caller field' });
    const secondary = screen.getByRole('button', { name: 'Caller cancel' });
    const primary = screen.getByRole('button', { name: 'Caller confirm' });
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab();
    expect(document.activeElement).toBe(field);
    await user.tab();
    expect(document.activeElement).toBe(secondary);
    await user.tab();
    expect(document.activeElement).toBe(primary);
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(primary);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(secondary);
  });

  it(`[AC-F1-01f-MODAL#3] ${name} 从标题反向 Tab 也留在弹层内`, async () => {
    const { user } = await openModal(Component);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Caller confirm' }));
  });

  for (const method of ['escape', 'backdrop', 'close'] as const) {
    it(`[AC-F1-01f-MODAL#4] ${name} ${method} 关闭一次并归还焦点，再次打开可正常使用`, async () => {
      const fixture = await openModal(Component);
      const { user, opener, onClose, portalContainer } = fixture;
      if (method === 'escape') await user.keyboard('{Escape}');
      if (method === 'backdrop') await user.click(part(portalContainer, 'modal-backdrop'));
      if (method === 'close')
        await user.click(screen.getByRole('button', { name: 'Caller close' }));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(opener);
      await user.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledTimes(1);
      await user.click(opener);
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Caller title' }));
      await user.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledTimes(2);
      expect(document.activeElement).toBe(opener);
    });
  }

  it(`[AC-F1-01f-MODAL#5] ${name} 点击正文不触发遮罩关闭，操作按钮各回调一次`, async () => {
    const { user, onClose, primary, secondary } = await openModal(Component);
    await user.click(screen.getByRole('textbox', { name: 'Caller field' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Caller cancel' }));
    expect(secondary).toHaveBeenCalledTimes(1);
    expect(primary).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Caller confirm' }));
    expect(primary).toHaveBeenCalledTimes(1);
    expect(secondary).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it(`[AC-F1-01f-MODAL#6] ${name} dismissible=false 禁止 Esc 与遮罩，保留显式关闭`, async () => {
    const { user, onClose, opener, portalContainer } = await openModal(Component, {
      dismissible: false,
    });
    await user.keyboard('{Escape}');
    await user.click(part(portalContainer, 'modal-backdrop'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Caller close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it(`[AC-F1-01f-MODAL#7] ${name} 资金/验证场景可单独禁用遮罩关闭而保留 Esc`, async () => {
    const { user, onClose, portalContainer } = await openModal(Component, {
      closeOnBackdrop: false,
    });
    await user.click(part(portalContainer, 'modal-backdrop'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it(`[AC-F1-01f-MODAL#8] ${name} 无说明或操作时没有悬空关联、默认文案，单按钮也循环`, async () => {
    render(
      createElement(
        Component,
        {
          open: true,
          title: 'Only title',
          closeLabel: 'Dismiss',
          onClose: vi.fn(),
        },
        'Only body',
      ),
    );
    const modal = screen.getByRole('dialog', { name: 'Only title' });
    expect(modal.hasAttribute('aria-describedby')).toBe(false);
    expect(modal.textContent).toContain('Only body');
    expect(modal.textContent).not.toMatch(/[\u3400-\u9fff]/u);
    expect(within(modal).getAllByRole('button')).toHaveLength(1);
    const close = within(modal).getByRole('button', { name: 'Dismiss' });
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(close);
  });

  it(`[AC-F1-01f-MODAL#9] ${name} open=false 不渲染弹层、不夺焦点、不响应 Esc`, async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    render(
      createElement(Component, { open: false, title: 'Hidden', closeLabel: 'Close', onClose }),
    );
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
    expect(document.body.textContent).not.toContain('Hidden');
    expect(document.activeElement).toBe(opener);
    await userEvent.setup().keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it(`[AC-F1-01f-MODAL#10] ${name} 调用方切换 open=false 或卸载时归还焦点`, () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const props: ModalProps = {
      open: true,
      title: 'External',
      closeLabel: 'Close',
      onClose: vi.fn(),
    };
    const view = render(createElement(Component, props));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'External' }));
    view.rerender(createElement(Component, { ...props, open: false }));
    expect(document.activeElement).toBe(opener);
    view.rerender(createElement(Component, props));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'External' }));
    view.unmount();
    expect(document.activeElement).toBe(opener);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it(`[AC-F1-01f-MODAL#11] ${name} 多个实例的标题和说明 ID 不冲突`, () => {
    render(
      createElement(
        'div',
        null,
        createElement(Component, {
          open: true,
          title: 'First title',
          description: 'First description',
          closeLabel: 'Close first',
          onClose: vi.fn(),
        }),
        createElement(Component, {
          open: true,
          title: 'Second title',
          description: 'Second description',
          closeLabel: 'Close second',
          onClose: vi.fn(),
        }),
      ),
    );
    const first = screen.getByRole('dialog', {
      name: 'First title',
      description: 'First description',
    });
    const second = screen.getByRole('dialog', {
      name: 'Second title',
      description: 'Second description',
    });
    expect(first.getAttribute('aria-labelledby')).not.toBe(second.getAttribute('aria-labelledby'));
    expect(first.getAttribute('aria-describedby')).not.toBe(
      second.getAttribute('aria-describedby'),
    );
  });
}
