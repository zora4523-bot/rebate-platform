import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfigProvider, Form, type FormInstance } from 'antd';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configCenterTexts as t } from '../../texts/config-center.ts';
import { BatchDrawer } from './BatchDrawer.tsx';
import type { ConfigRow } from './model.ts';
import { ValueField } from './ValueField.tsx';

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  // antd Form.Item subscribes to breakpoints; jsdom has no matchMedia.
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function row(key: string, patch: Partial<ConfigRow> = {}): ConfigRow {
  return {
    key,
    value: 500000,
    value_type: 'number',
    options: null,
    permission: 'config.general',
    admin_editable: true,
    version: 3,
    updated_by: null,
    updated_at: null,
    ...patch,
  };
}

function MoneyForm({ onForm }: { readonly onForm: (form: FormInstance) => void }) {
  const [form] = Form.useForm();
  onForm(form);
  return (
    <Form form={form} name="money-test" initialValues={{ value: null }}>
      <ValueField row={row('withdraw.max_amount_fen')} name="value" label={t.drawer.newValue} />
    </Form>
  );
}

it('[F1-06zg] the amount field keeps the exact typed text and refuses 12.340', async () => {
  let form: FormInstance | undefined;
  render(<MoneyForm onForm={(instance) => (form = instance)} />);
  const field = screen.getByRole('spinbutton', { name: t.drawer.newValue });
  // Nothing is validated before the operator types.
  expect(screen.queryByText(t.validation.required)).toBeNull();
  expect(field.getAttribute('aria-invalid')).not.toBe('true');
  await act(async () => {
    fireEvent.change(field, { target: { value: '12.340' } });
  });
  expect(form!.getFieldValue('value')).toBe('12.340');
  await act(async () => {
    await form!.validateFields().catch(() => undefined);
  });
  expect(screen.getByText(t.validation.moneyDecimals)).toBeDefined();
  await act(async () => {
    fireEvent.change(field, { target: { value: '12.34' } });
  });
  await act(async () => {
    await expect(form!.validateFields()).resolves.toEqual({ value: '12.34' });
  });
});

it('[F1-06zg] the batch drawer sends only the item the operator changed', async () => {
  const onSave = vi.fn();
  const never = row('earnings.dashboard.enabled', {
    value: null,
    value_type: 'boolean',
    version: 0,
  });
  const count = row('favorites.max_per_user', { value: 200 });
  render(
    // As in the app shell: no space inserted between two-character button labels.
    <ConfigProvider button={{ autoInsertSpace: false }}>
      <BatchDrawer
        group="other"
        rows={[never, count]}
        busy={false}
        notice={null}
        onClose={() => undefined}
        onSave={onSave}
      />
    </ConfigProvider>,
  );
  await act(async () => {
    fireEvent.change(screen.getByRole('spinbutton', { name: /favorites\.max_per_user/ }), {
      target: { value: '300' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: t.drawer.reason }), {
      target: { value: '调整收藏上限' },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: t.batchDrawer.save }));
  });
  await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave).toHaveBeenCalledWith(
    'config.general',
    [{ row: count, value: 300 }],
    '调整收藏上限',
  );
});
