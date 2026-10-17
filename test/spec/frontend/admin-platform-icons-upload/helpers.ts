import { act, configure, fireEvent, waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';
import {
  button,
  cell,
  clean,
  click,
  dialog,
  dialogs,
  mount,
  nameOf,
  squash,
} from '../admin-platform-icons/helpers.ts';
import {
  createUploadServer,
  isCreate,
  isUpload,
  type Key,
  type State,
  type UploadServer,
} from './fixtures.ts';
import { COPY } from './copy.ts';

export { COPY };

// Same window as the F1-06zd directory: the first antd Modal / Drawer / Upload / DatePicker render
// of a file (cold CSS-in-JS in jsdom) takes seconds on a loaded runner.
configure({ asyncUtilTimeout: 10_000 });

/** Per-test timeout of the multi-step flows (upload → preview → save → drawer). */
export const FLOW_TIMEOUT = 60_000;

/** Mounts the real admin app (createAdminShell) over the upload server; see the F1-06zd mount. */
export function mountUpload(state?: State | UploadServer) {
  const server: UploadServer =
    state !== undefined && 'fetch' in state ? state : createUploadServer(state);
  const view = mount(server);
  return { ...view, server };
}

export function uploads(server: UploadServer) {
  return server.log.filter(isUpload);
}

export function creates(server: UploadServer) {
  return server.log.filter(isCreate);
}

export function nonGet(server: UploadServer) {
  return server.log.filter((request) => request.method !== 'GET');
}

export const uploadTitle = (platform: string) => `上传替换图 · ${platform}`;

/** The open upload dialog of `platform` (an antd Modal). */
export async function uploadDialog(platform: string): Promise<HTMLElement> {
  const modal = await dialog(uploadTitle(platform));
  expect(modal.closest('.ant-modal'), 'the upload dialog is an antd Modal').not.toBeNull();
  return modal;
}

/** Opens the upload dialog from the list row 【上传 {平台}】. */
export async function openUploadFromRow(key: Key, platform: string): Promise<HTMLElement> {
  await click(button(cell(key, '操作'), `上传 ${platform}`));
  return uploadDialog(platform);
}

/** The one file input of the dialog (the input inside antd Upload). */
export function fileInput(modal: HTMLElement): HTMLInputElement {
  const inputs = modal.querySelectorAll<HTMLInputElement>('input[type="file"]');
  expect(inputs, 'one file input in the upload dialog').toHaveLength(1);
  return inputs[0]!;
}

/** Picks `file` in the dialog's file input (what the browser does after the file chooser). */
export async function chooseFile(modal: HTMLElement, file: File): Promise<void> {
  const input = fileInput(modal);
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
}

/** Buttons of `scope` whose accessible name or text is exactly `name`. */
export function buttonsNamed(scope: HTMLElement, name: string): HTMLButtonElement[] {
  return within(scope)
    .queryAllByRole('button')
    .filter(
      (item) =>
        squash(nameOf(item)) === squash(name) ||
        (nameOf(item) === '' && squash(item.textContent) === squash(name)) ||
        squash(item.textContent) === squash(name),
    )
    .filter((item): item is HTMLButtonElement => item instanceof HTMLButtonElement);
}

/** The one <button> named `name` in scope. */
export function onlyButton(scope: HTMLElement, name: string): HTMLButtonElement {
  const found = buttonsNamed(scope, name);
  expect(found, `button 「${name}」`).toHaveLength(1);
  return found[0]!;
}

/** Waits until the preview of an upload shows (the dialog holds an <img> of `url`). */
export async function previewShown(modal: HTMLElement, url: string): Promise<void> {
  await waitFor(() =>
    expect(
      Array.from(modal.querySelectorAll('img'), (image) => image.getAttribute('src')),
      'preview of the cleaned file',
    ).toContain(url),
  );
}

/** Selects `file` and presses 【上传并预览】; returns once the upload request was sent. */
export async function uploadFile(
  server: UploadServer,
  modal: HTMLElement,
  file: File,
): Promise<void> {
  const before = uploads(server).length;
  await chooseFile(modal, file);
  await waitFor(() => expect(onlyButton(modal, COPY.upload).disabled).toBe(false));
  await click(onlyButton(modal, COPY.upload));
  await waitFor(() => expect(uploads(server)).toHaveLength(before + 1));
}

/** The checkbox 「我已核对清洗后的预览」. */
export function confirmBox(modal: HTMLElement): HTMLInputElement {
  const found = within(modal).queryAllByRole('checkbox', { name: COPY.confirm });
  expect(found, `checkbox 「${COPY.confirm}」`).toHaveLength(1);
  return found[0] as HTMLInputElement;
}

/** The input labelled `label` (antd Form.Item label, or aria-label). */
export function field(scope: HTMLElement, label: RegExp): HTMLInputElement {
  const found = within(scope).queryAllByLabelText(label);
  const inputs = found.filter((item): item is HTMLInputElement => item instanceof HTMLInputElement);
  expect(inputs, `input labelled ${String(label)}`).toHaveLength(1);
  return inputs[0]!;
}

export async function typeText(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  });
}

/** Opens the date picker of `input` and clicks the day `value` (YYYY-MM-DD) in its panel. */
export async function pickDate(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.focus(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);
  });
  let target: HTMLElement | undefined;
  await waitFor(() => {
    const cells = Array.from(
      document.querySelectorAll<HTMLElement>(`.ant-picker-dropdown td[title="${value}"]`),
    ).filter(
      (item) =>
        !item.closest('.ant-picker-dropdown-hidden') &&
        !item.classList.contains('ant-picker-cell-disabled'),
    );
    expect(cells, `day ${value} in the open date panel`).toHaveLength(1);
    target = cells[0];
  });
  await click(target!);
  await waitFor(() => expect(input.value).toBe(value));
}

/** Fills the source registration of a dialog; an undefined value leaves that field empty. */
export async function fillSource(
  scope: HTMLElement,
  values: { readonly url?: string; readonly date?: string },
): Promise<void> {
  if (values.url !== undefined) await typeText(field(scope, COPY.sourceLabel), values.url);
  if (values.date !== undefined) await pickDate(field(scope, COPY.dateLabel), values.date);
}

/** Text of `scope` without whitespace contains every part. */
export function hasText(scope: Element, part: string): boolean {
  return squash(scope.textContent).includes(squash(part));
}

/** Every open dialog whose name starts with `title` (re-exported shape of the zd helper). */
export function openDialogs(title: string): HTMLElement[] {
  return dialogs(title);
}

export function textOf(element: Element): string {
  return clean(element.textContent);
}

/**
 * Open history drawers of `platform`: an open antd Drawer whose title starts with
 * 「版本历史 · {平台}」. Not by accessible name: under NODE_ENV=test every antd Drawer and Modal
 * gets the id 'test-id', and a dialog left behind by a closed Modal would be named after the
 * drawer's title.
 */
export function openDrawers(platform: string): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.ant-drawer.ant-drawer-open .ant-drawer-content'),
  ).filter((content) =>
    squash(content.querySelector('.ant-drawer-title')?.textContent).startsWith(
      squash(`版本历史 · ${platform}`),
    ),
  );
}

export async function historyDrawer(platform: string): Promise<HTMLElement> {
  await waitFor(() =>
    expect(openDrawers(platform), `drawer 版本历史 · ${platform}`).toHaveLength(1),
  );
  return openDrawers(platform)[0]!;
}
