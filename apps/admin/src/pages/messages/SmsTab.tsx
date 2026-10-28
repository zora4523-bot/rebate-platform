// 「短信」页签：每个 code × variant 一行（只列 sms_registrations 非空的编码）：编码 · 变体、签名、
// 模板 CODE（有新配置时另列「新配置 …」）、类型、预览正文、短信渠道、状态、操作。状态取在用配置与
// 「待测试」登记：已启用 / 待测试（受理后旁注「测试已受理」）/ 测试失败 / 未登记，SMS_CODE 兜底时
// 「部署配置兜底」。按钮：已启用【编辑】；待测试【编辑】【测试发送】（有在用配置时另有【放弃新配置】）；
// 测试失败【编辑】【重新测试】【放弃新配置】；未登记【登记】。没有 notify.channels 时不出按钮。
import {
  Alert,
  Button,
  Flex,
  Popconfirm,
  Table,
  Tag,
  Typography,
  type TableColumnsType,
} from 'antd';
import { useEffect, type ReactElement } from 'react';
import { messagesTexts as t } from '../../texts/messages.ts';
import { hasChannel, smsRowsOf, statusOf, type ChannelItem, type SmsRow } from './model.ts';

export interface SmsTabProps {
  readonly items: readonly ChannelItem[];
  /** 持有 notify.channels：给行按钮。 */
  readonly canWrite: boolean;
  /** 从「消息模板」页签来时要定位并高亮的编码。 */
  readonly focus: string | undefined;
  readonly onEdit: (code: string, variant: string) => void;
  readonly onTest: (code: string, variant: string) => void;
  readonly onDiscard: (code: string, variant: string) => void;
}

const STATUS_COLOR = {
  enabled: 'success',
  pending: 'processing',
  failed: 'error',
  unregistered: 'default',
} as const;

const rowId = (code: string): string => `messages-sms-${code}`;

function Note({ children }: { children: string }): ReactElement {
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {children}
    </Typography.Text>
  );
}

function StatusCell({ item, row }: SmsRow): ReactElement {
  const status = statusOf(row);
  const fallback = item.sms_deploy_fallback && row.active === null;
  const notes: string[] = [];
  if (row.pending?.test.status === 'accepted') notes.push(t.status.accepted);
  if (row.pending?.test.status === 'not_sent_no_verify_phone') notes.push(t.status.notSent);
  if (status === 'failed' && row.active !== null) notes.push(t.status.failedKept);
  if (fallback && status === 'unregistered') notes.push(t.status.fallbackNote);
  return (
    <Flex vertical align="flex-start" gap={2}>
      <Flex wrap gap={4}>
        {status === 'unregistered' && fallback ? null : (
          <Tag color={STATUS_COLOR[status]}>{t.status[status]}</Tag>
        )}
        {fallback ? <Tag color="warning">{t.status.fallback}</Tag> : null}
      </Flex>
      {notes.map((note) => (
        <Note key={note}>{note}</Note>
      ))}
    </Flex>
  );
}

export function SmsTab({
  items,
  canWrite,
  focus,
  onEdit,
  onTest,
  onDiscard,
}: SmsTabProps): ReactElement {
  const rows = smsRowsOf(items);

  useEffect(() => {
    if (focus === undefined) return;
    const target = document.getElementById(rowId(focus));
    if (target !== null && typeof target.scrollIntoView === 'function')
      target.scrollIntoView({ block: 'center' });
  }, [focus]);

  const link = (label: string, onClick: () => void): ReactElement => (
    <Button
      key={label}
      type="link"
      size="small"
      style={{ padding: 0 }}
      autoInsertSpace={false}
      onClick={onClick}
    >
      {label}
    </Button>
  );

  const actionsOf = ({ item, row }: SmsRow): ReactElement[] => {
    const { code } = item;
    const { variant } = row;
    const status = statusOf(row);
    if (status === 'unregistered') return [link(t.register, () => onEdit(code, variant))];
    const offered = [link(t.edit, () => onEdit(code, variant))];
    if (status === 'pending') offered.push(link(t.testSend, () => onTest(code, variant)));
    if (status === 'failed') offered.push(link(t.retest, () => onTest(code, variant)));
    if (status === 'failed' || (status === 'pending' && row.active !== null))
      offered.push(
        <Popconfirm
          key="discard"
          title={t.discardConfirm.title}
          description={t.discardConfirm.description}
          okText={t.discardConfirm.ok}
          cancelText={t.discardConfirm.cancel}
          onConfirm={() => onDiscard(code, variant)}
        >
          <Button type="link" size="small" danger style={{ padding: 0 }} autoInsertSpace={false}>
            {t.discard}
          </Button>
        </Popconfirm>,
      );
    return offered;
  };

  const columns: TableColumnsType<SmsRow> = [
    {
      key: 'code',
      title: t.smsColumns.code,
      render: (_, { item, row }) => (
        <span id={row === item.sms_registrations[0] ? rowId(item.code) : undefined}>
          <Typography.Text code>{`${item.code} · ${row.variant}`}</Typography.Text>
        </span>
      ),
    },
    {
      key: 'sign',
      title: t.smsColumns.sign,
      render: (_, { row }) => (row.active ?? row.pending)?.sign_name ?? t.dash,
    },
    {
      key: 'template',
      title: t.smsColumns.template,
      render: (_, { row }) => (
        <Flex vertical gap={2}>
          <span>{row.active?.template_code ?? t.dash}</span>
          {row.pending === null ? null : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {`${t.newConfig} ${row.pending.template_code} · ${
                statusOf(row) === 'failed' ? t.notEnabled : t.status.pending
              }`}
            </Typography.Text>
          )}
        </Flex>
      ),
    },
    {
      key: 'type',
      title: t.smsColumns.type,
      render: (_, { row }) => {
        const registered = row.active ?? row.pending;
        return registered === null
          ? t.dash
          : (t.templateTypes[registered.template_type] ?? registered.template_type);
      },
    },
    {
      key: 'preview',
      title: t.smsColumns.preview,
      render: (_, { row }) => {
        const text = (row.active ?? row.pending)?.preview_text;
        return text === undefined ? (
          t.dash
        ) : (
          <span
            title={text}
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              maxWidth: 320,
            }}
          >
            {text}
          </span>
        );
      },
    },
    {
      key: 'channel',
      title: t.smsColumns.channel,
      render: (_, { item }) =>
        item.sms_fixed
          ? t.channelState.fixed
          : hasChannel(item, 'sms')
            ? t.channelState.on
            : t.channelState.off,
    },
    {
      key: 'status',
      title: t.smsColumns.status,
      render: (_, entry) => <StatusCell {...entry} />,
    },
    ...(canWrite
      ? [
          {
            key: 'actions',
            title: t.smsColumns.actions,
            render: (_: unknown, entry: SmsRow) => (
              <Flex wrap gap={8}>
                {actionsOf(entry)}
              </Flex>
            ),
          },
        ]
      : []),
  ];

  return (
    <Flex vertical gap={12}>
      <Alert type="info" showIcon message={t.smsIntro} />
      <Alert type="warning" showIcon message={t.smsFundIntro} />
      <Table<SmsRow>
        rowKey="key"
        size="middle"
        columns={columns}
        dataSource={rows}
        pagination={false}
        rowClassName={({ item }) => (item.code === focus ? 'ant-table-row-selected' : '')}
        locale={{ emptyText: t.emptySms }}
      />
    </Flex>
  );
}
