// 编辑 / 登记短信抽屉（AdmNotifySmsEdit*）：编码、变体只读；当前生效与新配置；签名、阿里云模板 CODE、
// 模板类型（锁定）、预览正文，下方列出该变体定义的变量（只读）。【保存】先做前端预检（变量、验证码
// 有效期），再交给页面：首次登记或签名、模板 CODE 变了 → 测试发送弹窗（没有验证手机号则直接动态码）；
// 只改预览正文 → 动态码后直接保存。字段旁的提示来自预检或服务端 20001 的 data.fields。「待测试」登记
// 已受理时另给【启用新配置】。资金类编码没有 content.fund_terms 时只读，不给【保存】与【启用新配置】。
import { Alert, Button, Drawer, Flex, Form, Input, Radio, Tag, Typography } from 'antd';
import { useId, useState, type ReactElement } from 'react';
import { messagesTexts as t } from '../../texts/messages.ts';
import {
  PREVIEW_MAX,
  SIGN_MAX,
  TEMPLATE_MAX,
  enableReady,
  lockedType,
  needsTestSend,
  ttlMismatch,
  variableMismatch,
  type ChannelItem,
  type RegisterDraft,
  type SmsVariantRow,
} from './model.ts';

export type DrawerField = 'sign_name' | 'template_code' | 'template_type' | 'preview_text';
export type DrawerErrors = Partial<Record<DrawerField, string>>;

export interface SmsDrawerProps {
  readonly item: ChannelItem;
  readonly row: SmsVariantRow;
  /** 资金类编码而没有 content.fund_terms：只读。 */
  readonly readOnly: boolean;
  /** 页面在写（保存或启用在途）。 */
  readonly busy: boolean;
  /** 服务端按字段拒的提示（20001 data.fields）。 */
  readonly errors: DrawerErrors;
  /** 抽屉顶部的错误条（字段以外的拒绝、冲突、无权限）。 */
  readonly notice: string | undefined;
  /** 上次没存成功时填过的内容（【修改配置】回抽屉）。 */
  readonly draft: RegisterDraft | undefined;
  readonly onErrors: (errors: DrawerErrors) => void;
  readonly onSave: (draft: RegisterDraft, test: boolean) => void;
  readonly onEnable: () => void;
  readonly onClose: () => void;
}

const status = (error: string | undefined): { validateStatus?: 'error'; help?: string } =>
  error === undefined ? {} : { validateStatus: 'error', help: error };

const registered = (label: string, value: { sign_name: string; template_code: string }) =>
  `${label}${t.colon}${value.sign_name} · ${value.template_code}`;

export function SmsDrawer({
  item,
  row,
  readOnly,
  busy,
  errors,
  notice,
  draft,
  onErrors,
  onSave,
  onEnable,
  onClose,
}: SmsDrawerProps): ReactElement {
  const signId = useId();
  const templateId = useId();
  const previewId = useId();
  const titleId = useId();
  const initial = draft ?? row.pending ?? row.active;
  const type = lockedType(item, row);
  const [sign, setSign] = useState(initial?.sign_name ?? '');
  const [template, setTemplate] = useState(initial?.template_code ?? '');
  const [preview, setPreview] = useState(initial?.preview_text ?? '');
  const { code } = item;
  const { variant } = row;
  const first = row.active === null;
  const locked = readOnly || busy;

  const clear = (field: DrawerField) => {
    if (errors[field] === undefined) return;
    const next = { ...errors };
    delete next[field];
    onErrors(next);
  };

  const submit = () => {
    if (busy || readOnly) return;
    const signValue = sign.trim();
    const templateValue = template.trim();
    const next: DrawerErrors = {};
    if (signValue === '') next.sign_name = t.errors.signRequired;
    else if (signValue.length > SIGN_MAX) next.sign_name = t.errors.signInvalid;
    if (templateValue === '') next.template_code = t.errors.templateRequired;
    else if (templateValue.length > TEMPLATE_MAX) next.template_code = t.errors.templateInvalid;
    const mismatch = variableMismatch(preview, row.variables);
    const written = ttlMismatch(preview, item.sms_code_ttl_sec);
    if (preview.trim() === '') next.preview_text = t.errors.previewRequired;
    else if (preview.length > PREVIEW_MAX) next.preview_text = t.errors.previewTooLong;
    else if (mismatch !== undefined)
      next.preview_text = t.errors.previewVariables(mismatch.extra, mismatch.missing);
    else if (written !== undefined && item.sms_code_ttl_sec !== null)
      next.preview_text = t.errors.previewTtl(written, item.sms_code_ttl_sec);
    onErrors(next);
    if (Object.keys(next).length > 0) return;
    const payload: RegisterDraft = {
      sign_name: signValue,
      template_code: templateValue,
      template_type: type,
      preview_text: preview,
    };
    onSave(payload, needsTestSend(row, payload));
  };

  const close = () => {
    if (!busy) onClose();
  };

  const canEnable = !readOnly && enableReady(row);

  return (
    <Drawer
      open
      width={640}
      destroyOnHidden
      maskClosable={!busy}
      keyboard={!busy}
      onClose={close}
      // 标题自己渲染并用 React useId 关联：antd 在测试环境给 Drawer 与 Modal 的标题同一个 id，
      // 动态码对话框叠在抽屉上时它的可访问名会被抽屉标题顶替。
      aria-labelledby={titleId}
      footer={
        <Flex justify="end" gap={8}>
          <Button autoInsertSpace={false} disabled={busy} onClick={close}>
            {readOnly ? t.close : t.cancel}
          </Button>
          {canEnable ? (
            <Button autoInsertSpace={false} disabled={busy} onClick={onEnable}>
              {t.enable}
            </Button>
          ) : null}
          {readOnly ? null : (
            <Button type="primary" autoInsertSpace={false} loading={busy} onClick={submit}>
              {t.drawer.save}
            </Button>
          )}
        </Flex>
      }
    >
      <Flex vertical gap={12}>
        <Typography.Title id={titleId} level={5} style={{ margin: 0 }}>
          {first && row.pending === null
            ? t.drawer.registerTitle(code, variant)
            : t.drawer.editTitle(code, variant)}
        </Typography.Title>
        {notice === undefined ? null : <Alert type="error" showIcon message={notice} />}
        <Typography.Text>
          {row.active === null
            ? `${t.drawer.current}${t.colon}${t.drawer.currentNone}`
            : registered(t.drawer.current, row.active)}
        </Typography.Text>
        {row.pending === null ? null : (
          <Typography.Text>
            {registered(t.drawer.pending, row.pending)}
            {' · '}
            {row.pending.test.status === 'failed'
              ? t.status.failed
              : row.pending.test.status === 'accepted'
                ? t.withNote(t.status.pending, t.status.accepted)
                : t.withNote(t.status.pending, t.status.notSent)}
          </Typography.Text>
        )}
        {item.fund_terms ? (
          <Alert
            type="warning"
            showIcon
            message={readOnly ? t.drawer.fundReadOnly : t.drawer.fundWarning(code)}
          />
        ) : null}
        {readOnly && enableReady(row) ? (
          <Typography.Text type="secondary">{t.enableFundNeeded}</Typography.Text>
        ) : null}
        <Form layout="vertical" component="div" requiredMark={!readOnly}>
          <Form.Item
            label={t.drawer.sign}
            htmlFor={signId}
            required
            extra={t.drawer.signExtra}
            {...status(errors.sign_name)}
          >
            <Input
              id={signId}
              value={sign}
              maxLength={SIGN_MAX}
              disabled={locked}
              onChange={(event) => {
                setSign(event.target.value);
                clear('sign_name');
              }}
            />
          </Form.Item>
          <Form.Item
            label={t.drawer.template}
            htmlFor={templateId}
            required
            extra={t.drawer.templateExtra}
            {...status(errors.template_code)}
          >
            <Input
              id={templateId}
              value={template}
              maxLength={TEMPLATE_MAX}
              disabled={locked}
              onChange={(event) => {
                setTemplate(event.target.value);
                clear('template_code');
              }}
            />
          </Form.Item>
          <Form.Item
            label={t.drawer.type}
            extra={t.drawer.typeLocked}
            {...status(errors.template_type)}
          >
            <Radio.Group
              value={type}
              disabled
              options={[
                { value: 'verify', label: t.templateTypes['verify'] ?? 'verify' },
                { value: 'notice', label: t.templateTypes['notice'] ?? 'notice' },
              ]}
            />
          </Form.Item>
          <Form.Item
            label={t.drawer.preview}
            htmlFor={previewId}
            required
            extra={`${t.drawer.previewExtra} ${t.drawer.previewCount(preview.length)}`}
            {...status(errors.preview_text)}
          >
            <Input.TextArea
              id={previewId}
              value={preview}
              autoSize={{ minRows: 3, maxRows: 6 }}
              disabled={locked}
              onChange={(event) => {
                setPreview(event.target.value);
                clear('preview_text');
              }}
            />
          </Form.Item>
        </Form>
        <Flex vertical gap={4}>
          <Typography.Text type="secondary">{t.drawer.variables}</Typography.Text>
          <Flex wrap gap={4}>
            {row.variables.length === 0 ? (
              <Typography.Text type="secondary">{t.drawer.noVariables}</Typography.Text>
            ) : (
              row.variables.map((name) => <Tag key={name}>{`\${${name}}`}</Tag>)
            )}
          </Flex>
        </Flex>
        {readOnly ? null : (
          <Typography.Text type="secondary">
            {first ? t.drawer.footnoteFirst : t.drawer.footnote}
          </Typography.Text>
        )}
      </Flex>
    </Drawer>
  );
}
