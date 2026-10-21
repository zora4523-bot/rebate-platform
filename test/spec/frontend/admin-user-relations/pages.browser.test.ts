/// <reference types="@vitest/browser-playwright" />
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { CHANGE_REASON, NEW_PARENT, invitees } from './relations-fixtures.ts';
import { FIRST, screenshot, showBrowser, unmount } from './relations-browser.ts';

afterEach(unmount);

it('[AC-F1-07g-BROWSER#1] 1440 直推名单抽屉截图，对照 AdmUserInvitees', async () => {
  await page.viewport(1440, 1320);
  const marker = await showBrowser();
  const trigger = page.getByRole('button', { name: '查看直推名单' });
  await expect.element(trigger, FIRST).toBeVisible();
  await trigger.click();
  const panel = page.getByRole('dialog', { name: /直推名单/ });
  await expect.element(panel, FIRST).toBeVisible();
  await expect.element(panel, FIRST).toMatchTextContent(invitees()[0]!.user_id);
  await expect.element(panel, FIRST).toMatchTextContent('138****5678');
  await expect.element(panel.getByRole('columnheader', { name: '注册时间' }), FIRST).toBeVisible();
  await screenshot('admin-user-invitees', marker);
}, 40_000);

it('[AC-F1-07g-BROWSER#2] 1440 可改上级对话框截图，对照 AdmUserInviterChangeOk', async () => {
  await page.viewport(1440, 1100);
  const marker = await showBrowser();
  const trigger = page.getByRole('button', { name: '改上级' });
  await expect.element(trigger, FIRST).toBeVisible();
  await trigger.click();
  const modal = page.getByRole('dialog', { name: /改上级/ });
  await expect.element(modal, FIRST).toBeVisible();
  const input = modal.getByRole('textbox', { name: /新上级|上级.*UID|邀请人/ });
  await expect.element(input, FIRST).toBeVisible();
  await input.fill(NEW_PARENT);
  await modal.getByRole('textbox', { name: /原因/ }).fill(CHANGE_REASON);
  await expect.element(modal.getByRole('radio', { name: /解绑/ }), FIRST).toBeVisible();
  await expect.element(modal.getByRole('button', { name: '验证并保存' }), FIRST).toBeEnabled();
  await screenshot('admin-user-inviter-change', marker);
}, 40_000);

it('[AC-F1-07g-BROWSER#3] 1440 调等级对话框截图，对照 AdmUserLevelChange', async () => {
  await page.viewport(1440, 1320);
  const marker = await showBrowser();
  const trigger = page.getByRole('button', { name: '调等级' });
  await expect.element(trigger, FIRST).toBeVisible();
  await trigger.click();
  const modal = page.getByRole('dialog', { name: /调等级/ });
  await expect.element(modal, FIRST).toBeVisible();
  const level = modal.getByRole('combobox', { name: /等级/ });
  await expect.element(level, FIRST).toBeVisible();
  await level.click();
  await expect.element(level, FIRST).toHaveAttribute('aria-expanded', 'true');
  const dropdown = document.querySelector<HTMLElement>(
    '.ant-select-dropdown:not(.ant-select-dropdown-hidden)',
  );
  await expect.element(dropdown, FIRST).toBeVisible();
  const option = Array.from(
    dropdown!.querySelectorAll<HTMLElement>('.ant-select-item-option-content'),
  ).find((node) => node.textContent?.trim() === 'L3');
  await expect.element(option ?? null, FIRST).toBeVisible();
  await page.elementLocator(option!).click();
  await modal.getByRole('textbox', { name: /原因/ }).fill(CHANGE_REASON);
  await expect.element(modal, FIRST).toMatchTextContent('L3');
  await expect.element(modal.getByRole('button', { name: '验证并保存' }), FIRST).toBeEnabled();
  await screenshot('admin-user-level-change', marker);
}, 40_000);
