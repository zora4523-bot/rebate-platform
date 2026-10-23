// 未实现接口清单（D10-284）：契约里仍标 `x-implementation: planned` 的 operationId。外壳经
// createAdminShell 的 plannedOperations 选项放进上下文；页面、页签、按钮用 usePlanned 声明自己依赖
// 的接口。没有传清单（测试、嵌入）时是空集，什么都不屏蔽。
import type { operations } from '@couli/contracts-ts';
import { createContext, useContext } from 'react';
import { plannedTexts } from '../../texts/shell.ts';

/** 契约里的 operationId（拼错时类型检查就报）。 */
export type OperationId = keyof operations & string;

const NOTHING: ReadonlySet<string> = new Set();

export const PlannedOperationsContext = createContext<ReadonlySet<string>>(NOTHING);

/** 给定的 operationId 里有任何一个还是 planned（接口未上线）时为 true。 */
export function usePlanned(...operationIds: readonly OperationId[]): boolean {
  const planned = useContext(PlannedOperationsContext);
  return operationIds.some((id) => planned.has(id));
}

/**
 * 调 planned 写接口的按钮：置灰，并在按钮自己身上标「功能开发中」（悬停提示 title 与读屏描述
 * aria-description）。接口已上线时不加任何属性。
 */
export function plannedButtonProps(planned: boolean): {
  disabled?: true;
  title?: string;
  'aria-description'?: string;
} {
  return planned
    ? { disabled: true, title: plannedTexts.title, 'aria-description': plannedTexts.title }
    : {};
}
