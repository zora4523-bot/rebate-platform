// Write requests of the configuration center (single change, rollback, batch) and how each maps
// onto its endpoint. The payload is fixed when the operator confirms, so a replay after a new
// step-up (10003) sends exactly the same body with the new token.
import type { Schema } from '@couli/contracts-ts';
import { configCenterTexts as t } from '../../texts/config-center.ts';
import {
  BATCH_URL,
  displayName,
  itemUrl,
  valueLabel,
  type ConfigRow,
  type ConfigValue,
  type GroupId,
  type NewValue,
} from './model.ts';

export interface BatchEntry {
  readonly row: ConfigRow;
  readonly value: NewValue;
}

export type WriteRequest =
  | {
      readonly kind: 'edit';
      readonly row: ConfigRow;
      readonly value: NewValue;
      readonly reason: string;
    }
  | {
      readonly kind: 'rollback';
      readonly row: ConfigRow;
      readonly toVersion: number;
      readonly toValue: ConfigValue;
      readonly reason: string;
    }
  | {
      readonly kind: 'batch';
      readonly group: GroupId;
      readonly permission: ConfigRow['permission'];
      readonly entries: readonly BatchEntry[];
      readonly reason: string;
    };

export interface HttpCall {
  readonly url: string;
  readonly method: 'put' | 'post';
  readonly payload:
    | Schema<'AdminConfigItemUpdateRequest'>
    | Schema<'AdminConfigItemRollbackRequest'>
    | Schema<'AdminConfigItemBatchRequest'>;
}

export function permissionOf(request: WriteRequest): ConfigRow['permission'] {
  return request.kind === 'batch' ? request.permission : request.row.permission;
}

export function keysOf(request: WriteRequest): readonly string[] {
  return request.kind === 'batch'
    ? request.entries.map((entry) => entry.row.key)
    : [request.row.key];
}

export function callOf(request: WriteRequest): HttpCall {
  switch (request.kind) {
    case 'edit':
      return {
        url: itemUrl(request.row.key),
        method: 'put',
        payload: {
          value: request.value,
          expected_version: request.row.version,
          reason: request.reason,
        },
      };
    case 'rollback':
      return {
        url: `${itemUrl(request.row.key)}/rollback`,
        method: 'post',
        payload: {
          to_version: request.toVersion,
          expected_version: request.row.version,
          reason: request.reason,
        },
      };
    case 'batch':
      return {
        url: BATCH_URL,
        method: 'post',
        payload: {
          items: request.entries.map((entry) => ({
            key: entry.row.key,
            value: entry.value,
            expected_version: entry.row.version,
          })),
          reason: request.reason,
        },
      };
  }
}

/** Operation line of the step-up dialog. */
export function operationOf(request: WriteRequest): string {
  if (request.kind === 'edit') return t.stepUp.edit(displayName(request.row.key));
  if (request.kind === 'rollback')
    return t.stepUp.rollback(displayName(request.row.key), request.toVersion);
  return t.stepUp.batch(t.groups[request.group], request.entries.length);
}

/** Detail lines of the step-up dialog: key, from → to. */
export function detailsOf(request: WriteRequest): string[] {
  if (request.kind === 'edit')
    return [
      t.stepUp.detail(
        request.row.key,
        valueLabel(request.row, request.row.value),
        valueLabel(request.row, request.value),
      ),
    ];
  if (request.kind === 'rollback')
    return [
      t.stepUp.detail(
        request.row.key,
        valueLabel(request.row, request.row.value),
        valueLabel(request.row, request.toValue),
      ),
    ];
  return request.entries.map((entry) =>
    t.stepUp.detail(
      entry.row.key,
      valueLabel(entry.row, entry.row.value),
      valueLabel(entry.row, entry.value),
    ),
  );
}
