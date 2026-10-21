// Shared pieces of the order list and detail: the status tag (dictionary name and code, the code
// alone while BR-TEXT-25 has no row) and the order flags, each its own tag so 「已锁定」 and
// 「归属已锁定」 stand side by side.
import { LockOutlined, PauseCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { Flex, Tag, Typography, theme } from 'antd';
import type { ReactElement } from 'react';
import { ordersTexts as t } from '../../texts/orders.ts';
import { codeLabel, dictName, toneOf, type DictKind, type OrderRow } from './model.ts';

export function StatusTag(props: {
  readonly kind: DictKind;
  readonly code: string;
  /** List cells: the name in the tag and the code on its own line under it (AdmOrders). */
  readonly stacked?: boolean;
}): ReactElement {
  const { token } = theme.useToken();
  const name = dictName(props.kind, props.code);
  const codeStyle = { fontFamily: token.fontFamilyCode, fontSize: token.fontSizeSM } as const;
  if (props.stacked === true && name !== undefined) {
    return (
      <Flex vertical align="flex-start" gap={2}>
        <Tag color={toneOf(props.code)} style={{ marginInlineEnd: 0 }}>
          {name}
        </Tag>
        <Typography.Text type="secondary" style={codeStyle}>
          {props.code}
        </Typography.Text>
      </Flex>
    );
  }
  return (
    <Tag color={toneOf(props.code)} style={{ marginInlineEnd: 0, ...codeStyle }}>
      {codeLabel(props.kind, props.code)}
    </Tag>
  );
}

/** The flags that are set, one tag each; none shows the dash. */
export function FlagTags(props: {
  readonly flags: OrderRow['flags'];
  readonly holdReason: OrderRow['hold_reason'];
}): ReactElement {
  const { flags, holdReason } = props;
  const tags: ReactElement[] = [];
  if (flags.locked)
    tags.push(
      <Tag key="locked" bordered={false} style={{ marginInlineEnd: 0 }}>
        {t.flags.locked}
      </Tag>,
    );
  if (flags.status_locked)
    tags.push(
      <Tag
        key="status_locked"
        bordered={false}
        icon={<LockOutlined aria-hidden />}
        style={{ marginInlineEnd: 0 }}
      >
        {t.flags.statusLocked}
      </Tag>,
    );
  if (flags.rights_pending)
    tags.push(
      <Tag
        key="rights_pending"
        color="warning"
        icon={<WarningOutlined aria-hidden />}
        style={{ marginInlineEnd: 0 }}
      >
        {t.flags.rightsPending}
      </Tag>,
    );
  if (flags.hold)
    tags.push(
      <Tag
        key="hold"
        color="warning"
        icon={<PauseCircleOutlined aria-hidden />}
        style={{ marginInlineEnd: 0 }}
      >
        {holdReason === null
          ? t.flags.hold
          : t.flags.holdWithReason(codeLabel('hold_reason', holdReason))}
      </Tag>,
    );
  if (tags.length === 0) return <span>{t.dash}</span>;
  return (
    <Flex vertical align="flex-start" gap={4}>
      {tags}
    </Flex>
  );
}
