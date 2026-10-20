// Claim review page (design-hifi AdmClaimReview; design/specs/admin-claims.md §2, §4, §6; 01
// F-ADM-06, F1-07f): the claim as GET /admin/v1/claims/{claim_id} returns it, the evidence view
// (what the user filled in against what the union reported, the server's verdict per field, the
// link records counted as evidence) and one review card per child order. Each child order is
// approved or rejected on its own with a note (≥ 5 characters after trimming) and, to reject,
// one of the six staff reasons; the returned claim replaces the whole view. Attribution is never
// decided here: a child order the system closed (attributed before the review, or the order
// voided) is only reported as the server returned it. 20902 means another reviewer was first:
// the claim is read again once and nothing is resent.
import { ArrowLeftOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Col,
  Flex,
  Form,
  Input,
  Result,
  Row,
  Select,
  Skeleton,
  Table,
  Tag,
  Typography,
  theme,
  type TableColumnsType,
} from 'antd';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { claimsTexts as t } from '../../texts/claims.ts';
import type { ClaimsBackState } from './ClaimsPage.tsx';
import {
  NOTE_MAX,
  STAFF_REJECT_REASONS,
  beijingTime,
  claimUrl,
  createRequestGate,
  evidenceLabel,
  evidenceTone,
  failureOf,
  itemActionUrl,
  matchFieldLabel,
  noteLength,
  noteProblem,
  outcomeOf,
  platformLabel,
  rejectReasonLabel,
  sceneLabel,
  statusLabel,
  statusTone,
  validNote,
  type ClaimDetail,
  type ClaimItem,
  type ReviewOutcome,
  type StaffRejectReason,
} from './model.ts';

export interface ClaimReviewPageProps {
  readonly access: AccessControl;
  readonly claimId: string;
}

type PageStatus = 'loading' | 'ready' | 'failed' | 'invalid' | 'forbidden';
type Mode = 'approve' | 'reject';
type Match = ClaimItem['matches'][number];
type EvidenceLink = ClaimItem['evidence_links'][number];

interface ItemDraft {
  readonly note: string;
  readonly mode: Mode;
  readonly reason: StaffRejectReason | undefined;
  readonly error: string | undefined;
}

const EMPTY_DRAFT: ItemDraft = { note: '', mode: 'approve', reason: undefined, error: undefined };

function backSearchOf(state: unknown): string {
  if (typeof state !== 'object' || state === null || !('claimsSearch' in state)) return '';
  const search = (state as ClaimsBackState).claimsSearch;
  return typeof search === 'string' ? search : '';
}

export function ClaimReviewPage({ access, claimId }: ClaimReviewPageProps): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const back = () => void navigate(`/claims${backSearchOf(location.state)}`);
  return (
    <Flex vertical gap={16}>
      {access.can('order.claim') ? (
        <ReviewContent claimId={claimId} onBack={back} />
      ) : (
        <>
          <Header onBack={back} />
          <Card>
            <Result
              status="403"
              title={t.review.forbiddenTitle}
              subTitle={t.review.forbiddenDescription}
            />
          </Card>
        </>
      )}
    </Flex>
  );
}

function Header({
  onBack,
  claim,
}: {
  readonly onBack: () => void;
  readonly claim?: ClaimDetail | undefined;
}): ReactElement {
  const { token } = theme.useToken();
  return (
    <Flex align="center" justify="space-between" gap={16} wrap>
      <Flex align="center" gap={12} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t.review.title}
        </Typography.Title>
        {claim === undefined ? null : (
          <>
            <span style={{ fontFamily: token.fontFamilyCode, wordBreak: 'break-all' }}>
              {claim.claim_id}
            </span>
            <Tag color={statusTone(claim.status)} style={{ marginInlineEnd: 0 }}>
              {statusLabel(claim.status)}
            </Tag>
          </>
        )}
      </Flex>
      <Button icon={<ArrowLeftOutlined aria-hidden />} onClick={onBack}>
        {t.review.back}
      </Button>
    </Flex>
  );
}

function ReviewContent({
  claimId,
  onBack,
}: {
  readonly claimId: string;
  readonly onBack: () => void;
}): ReactElement {
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const [status, setStatus] = useState<PageStatus>('loading');
  const [claim, setClaim] = useState<ClaimDetail>();
  const [attempt, setAttempt] = useState(0);
  const [drafts, setDrafts] = useState<Readonly<Record<string, ItemDraft>>>({});
  const [submitting, setSubmitting] = useState<string>();
  const [outcome, setOutcome] = useState<{ itemId: string; kind: ReviewOutcome }>();
  const [conflict, setConflict] = useState(false);
  // After a 20902 the claim is read again; review actions stay locked until that read settles.
  const [refreshing, setRefreshing] = useState(false);
  const submittingRef = useRef(false);
  const refreshingRef = useRef(false);
  const [gate] = useState(createRequestGate);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    const token = gate.issue();
    const settle = (): boolean => {
      if (!current) return false;
      refreshingRef.current = false;
      setRefreshing(false);
      // A write sent after this read already put a newer claim on screen.
      return gate.isLatest(token);
    };
    custom<ClaimDetail>({ url: claimUrl(claimId), method: 'get' }).then(
      (response) => {
        if (!settle()) return;
        setClaim(response.data);
        setStatus('ready');
      },
      (cause: unknown) => {
        if (!settle()) return;
        const kind = failureOf(cause);
        // Nothing of the claim stays on screen after a failed read.
        setClaim(undefined);
        if (kind === 'forbidden') setStatus('forbidden');
        else if (kind === 'invalid') setStatus('invalid');
        else setStatus('failed');
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, gate, claimId, attempt]);

  const retry = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  const draftOf = (itemId: string): ItemDraft => drafts[itemId] ?? EMPTY_DRAFT;
  const patch = (itemId: string, change: Partial<ItemDraft>) =>
    setDrafts((previous) => ({
      ...previous,
      [itemId]: { ...(previous[itemId] ?? EMPTY_DRAFT), ...change },
    }));

  const submit = async (item: ClaimItem, mode: Mode) => {
    if (submittingRef.current || refreshingRef.current) return;
    const draft = draftOf(item.item_id);
    if (mode === 'reject' && draft.reason === undefined) {
      patch(item.item_id, { error: t.review.rejectReasonMissing });
      return;
    }
    const problem = noteProblem(draft.note);
    const note = validNote(draft.note);
    if (problem !== undefined || note === undefined) {
      patch(item.item_id, {
        error: problem === 'long' ? t.review.noteTooLong : t.review.noteTooShort,
      });
      return;
    }
    submittingRef.current = true;
    setSubmitting(item.item_id);
    setConflict(false);
    setOutcome(undefined);
    patch(item.item_id, { error: undefined });
    const token = gate.issue();
    try {
      const custom = getProvider().custom;
      if (custom === undefined) throw new Error('Missing custom data provider');
      const payload =
        mode === 'reject'
          ? { expected_row_version: item.row_version, reason: note, reject_reason: draft.reason }
          : { expected_row_version: item.row_version, reason: note };
      const response = await custom<ClaimDetail>({
        url: itemActionUrl(claimId, item.item_id, mode),
        method: 'post',
        payload,
      });
      if (!alive.current || !gate.isLatest(token)) return;
      // The whole returned claim replaces the view (status, note and every child order).
      setClaim(response.data);
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[item.item_id];
        return next;
      });
      const kind = outcomeOf(response.data.items.find((entry) => entry.item_id === item.item_id));
      setOutcome(kind === 'reviewed' ? undefined : { itemId: item.item_id, kind });
    } catch (cause) {
      if (!alive.current || !gate.isLatest(token)) return;
      const kind = failureOf(cause);
      if (kind === 'forbidden') {
        setClaim(undefined);
        setStatus('forbidden');
      } else if (kind === 'conflict') {
        // Another reviewer was first: close the stale form and read the claim once more.
        setConflict(true);
        patch(item.item_id, { mode: 'approve', error: undefined });
        refreshingRef.current = true;
        setRefreshing(true);
        setAttempt((value) => value + 1);
      } else {
        patch(item.item_id, { error: kind === 'invalid' ? t.review.invalid : t.review.failed });
      }
    } finally {
      submittingRef.current = false;
      if (alive.current) setSubmitting(undefined);
    }
  };

  if (status === 'forbidden') {
    return (
      <>
        <Header onBack={onBack} />
        <Card>
          <Result
            status="403"
            title={t.review.forbiddenTitle}
            subTitle={t.review.forbiddenDescription}
          />
        </Card>
      </>
    );
  }
  if (status === 'invalid') {
    return (
      <>
        <Header onBack={onBack} />
        <Card>
          <Result
            status="warning"
            title={t.review.invalidTitle}
            subTitle={t.review.invalidDescription}
          />
        </Card>
      </>
    );
  }
  if (status === 'failed') {
    return (
      <>
        <Header onBack={onBack} />
        <Card>
          <Result
            status="warning"
            icon={
              <Flex
                align="center"
                justify="center"
                style={{
                  width: 56,
                  height: 56,
                  marginInline: 'auto',
                  borderRadius: '50%',
                  background: token.colorErrorBg,
                }}
              >
                <WarningOutlined aria-hidden style={{ fontSize: 24, color: token.colorError }} />
              </Flex>
            }
            title={
              <Typography.Text type="danger" strong style={{ fontSize: token.fontSize }}>
                {t.review.loadFailedTitle}
              </Typography.Text>
            }
            subTitle={t.review.loadFailedDescription}
            extra={
              <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={retry}>
                {t.retry}
              </Button>
            }
          />
        </Card>
      </>
    );
  }
  if (claim === undefined) {
    return (
      <>
        <Header onBack={onBack} />
        <Card>
          <Typography.Text type="secondary" role="status">
            {t.review.loading}
          </Typography.Text>
          <Skeleton active title={false} paragraph={{ rows: 6 }} style={{ marginTop: 16 }} />
        </Card>
      </>
    );
  }

  const pending = claim.items.filter((item) => item.decision === null).length;
  return (
    <>
      <Header onBack={onBack} claim={claim} />
      {conflict ? <Alert type="warning" showIcon message={t.review.conflict} /> : null}
      <Row gutter={[16, 16]} align="top">
        <Col xs={24} xl={12}>
          <Flex vertical gap={16}>
            <ClaimInfo claim={claim} />
            <EvidenceView claim={claim} />
          </Flex>
        </Col>
        <Col xs={24} xl={12}>
          <Card
            title={t.review.ordersTitle}
            extra={
              <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                {t.review.ordersSummary(claim.items.length, pending)}
              </Typography.Text>
            }
          >
            <Flex vertical gap={16}>
              <Alert type="info" showIcon message={t.review.notice} />
              {claim.items.map((item) => (
                <ItemCard
                  key={item.item_id}
                  item={item}
                  draft={draftOf(item.item_id)}
                  busy={submitting !== undefined || refreshing}
                  outcome={outcome?.itemId === item.item_id ? outcome.kind : undefined}
                  onChange={(change) => patch(item.item_id, change)}
                  onSubmit={(mode) => void submit(item, mode)}
                />
              ))}
            </Flex>
          </Card>
        </Col>
      </Row>
    </>
  );
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  const { token } = theme.useToken();
  return (
    <Flex vertical gap={4} style={{ minWidth: 0 }}>
      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
        {label}
      </Typography.Text>
      <div style={{ wordBreak: 'break-all' }}>{children}</div>
    </Flex>
  );
}

function ClaimInfo({ claim }: { readonly claim: ClaimDetail }): ReactElement {
  const { token } = theme.useToken();
  const code: CSSProperties = { fontFamily: token.fontFamilyCode };
  const f = t.review.fields;
  return (
    <Card title={t.review.infoTitle}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 20 }}>
        <Field label={f.claimId}>
          <span style={code}>{claim.claim_id}</span>
        </Field>
        <Field label={f.status}>
          <Tag color={statusTone(claim.status)} style={{ marginInlineEnd: 0 }}>
            {statusLabel(claim.status)}
          </Tag>
        </Field>
        <Field label={f.applicant}>
          <Flex vertical gap={2}>
            <span style={code}>{claim.user.user_id}</span>
            <Typography.Text type="secondary" style={{ ...code, fontSize: token.fontSizeSM }}>
              {claim.user.phone_masked ?? t.dash}
            </Typography.Text>
          </Flex>
        </Field>
        <Field label={f.submittedAt}>{beijingTime(claim.submitted_at)}</Field>
        <Field label={f.platform}>{platformLabel(claim.platform)}</Field>
        <Field label={f.orderNo}>
          <span style={code}>{claim.order_no}</span>
        </Field>
        <Field label={f.paidDate}>{claim.paid_date}</Field>
        <Field label={f.evidence}>
          <Tag color={evidenceTone(claim.evidence_level)} style={{ marginInlineEnd: 0 }}>
            {`${evidenceLabel(claim.evidence_level)} ${claim.evidence_level}`}
          </Tag>
        </Field>
      </div>
      <div style={{ marginTop: 20 }}>
        <Field label={f.reason}>{claim.reason ?? t.dash}</Field>
      </div>
    </Card>
  );
}

function EvidenceView({ claim }: { readonly claim: ClaimDetail }): ReactElement {
  const { token } = theme.useToken();
  const code: CSSProperties = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' };
  const c = t.review.compareColumns;
  const compareColumns: TableColumnsType<Match> = [
    {
      key: 'compareField',
      title: c.field,
      width: 96,
      render: (_, row) => matchFieldLabel(row.field),
    },
    {
      key: 'user',
      title: c.user,
      render: (_, row) => <span style={code}>{row.user_value ?? t.dash}</span>,
    },
    {
      key: 'union',
      title: c.union,
      render: (_, row) => <span style={code}>{row.union_value ?? t.dash}</span>,
    },
    {
      key: 'verdict',
      title: c.verdict,
      width: 96,
      // The server's verdict only; the strings are never compared here.
      render: (_, row) => (
        <Tag color={row.matched ? 'success' : 'error'} style={{ marginInlineEnd: 0 }}>
          {row.matched ? t.review.matched : t.review.mismatched}
        </Tag>
      ),
    },
  ];
  const l = t.review.linkColumns;
  const linkColumns: TableColumnsType<EvidenceLink & { readonly key: string }> = [
    {
      key: 'at',
      title: l.at,
      width: 180,
      render: (_, row) => <span style={{ whiteSpace: 'nowrap' }}>{beijingTime(row.at)}</span>,
    },
    {
      key: 'scene',
      title: l.scene,
      render: (_, row) => (
        <Flex align="center" gap={8} wrap>
          <span>{sceneLabel(row.scene)}</span>
          <Typography.Text type="secondary" style={{ ...code, fontSize: token.fontSizeSM }}>
            {row.scene}
          </Typography.Text>
        </Flex>
      ),
    },
  ];
  return (
    <Card title={t.review.evidenceTitle}>
      <Flex vertical gap={20}>
        <Alert type="info" showIcon message={t.review.evidenceNote} />
        {claim.items.map((item, index) => (
          <Flex key={item.item_id} vertical gap={12}>
            <Flex align="center" justify="space-between" gap={12} wrap>
              <Typography.Text strong>
                {t.review.childHeading(index + 1)}
                <span style={code}>{item.sub_order_id}</span>
              </Typography.Text>
              <Tag color={evidenceTone(item.evidence)} style={{ marginInlineEnd: 0 }}>
                {`${evidenceLabel(item.evidence)} ${item.evidence}`}
              </Tag>
            </Flex>
            <Table<Match>
              size="small"
              rowKey={(row) => row.field}
              columns={compareColumns}
              dataSource={item.matches}
              pagination={false}
            />
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              {t.review.linksHeading}
            </Typography.Text>
            {item.evidence_links.length === 0 ? (
              <Typography.Text type="secondary">{t.review.noLinks}</Typography.Text>
            ) : (
              <Table<EvidenceLink & { readonly key: string }>
                size="small"
                columns={linkColumns}
                dataSource={item.evidence_links.map((link, position) => ({
                  ...link,
                  key: `${String(position)}:${link.at}`,
                }))}
                pagination={false}
              />
            )}
          </Flex>
        ))}
      </Flex>
    </Card>
  );
}

interface ItemCardProps {
  readonly item: ClaimItem;
  readonly draft: ItemDraft;
  readonly busy: boolean;
  readonly outcome: ReviewOutcome | undefined;
  readonly onChange: (change: Partial<ItemDraft>) => void;
  readonly onSubmit: (mode: Mode) => void;
}

function ItemCard({ item, draft, busy, outcome, onChange, onSubmit }: ItemCardProps): ReactElement {
  const { token } = theme.useToken();
  const noteId = useId();
  const reasonId = useId();
  const code: CSSProperties = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' };
  const title = (
    <Flex align="center" gap={8} wrap>
      <span style={code}>{item.sub_order_id}</span>
    </Flex>
  );
  const evidence = (
    <Tag color={evidenceTone(item.evidence)} style={{ marginInlineEnd: 0 }}>
      {`${evidenceLabel(item.evidence)} ${item.evidence}`}
    </Tag>
  );

  let notice: ReactElement | null = null;
  if (outcome === 'auto_attributed')
    notice = (
      <Alert
        type="warning"
        showIcon
        message={t.review.autoAttributed}
        description={t.review.autoAttributedDescription}
      />
    );
  else if (outcome === 'order_invalid')
    notice = <Alert type="warning" showIcon message={t.review.orderInvalid} />;

  if (item.decision !== null) {
    const decidedBy = item.decided_by === null ? t.review.system : (item.decided_by_name ?? t.dash);
    return (
      <Card size="small" title={title} extra={evidence}>
        <Flex vertical gap={12}>
          {notice}
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 16 }}
          >
            <Field label={t.review.decision}>
              <Flex vertical align="flex-start" gap={4}>
                <Tag color={statusTone(item.decision)} style={{ marginInlineEnd: 0 }}>
                  {statusLabel(item.decision)}
                </Tag>
                {item.reject_reason === null ? null : (
                  <span>{rejectReasonLabel(item.reject_reason)}</span>
                )}
              </Flex>
            </Field>
            <Field label={t.review.decidedBy}>{decidedBy}</Field>
            <Field label={t.review.decidedAt}>{beijingTime(item.decided_at)}</Field>
          </div>
        </Flex>
      </Card>
    );
  }

  const rejecting = draft.mode === 'reject';
  return (
    <Card size="small" title={title} extra={evidence}>
      <Form layout="vertical" component="div">
        {rejecting ? (
          <Form.Item label={t.review.rejectReason} htmlFor={reasonId} required>
            <Select<StaffRejectReason | undefined>
              id={reasonId}
              value={draft.reason}
              placeholder={t.review.rejectReasonPlaceholder}
              disabled={busy}
              onChange={(reason) => onChange({ reason, error: undefined })}
              options={STAFF_REJECT_REASONS.map((value) => ({
                value,
                label: rejectReasonLabel(value),
              }))}
            />
          </Form.Item>
        ) : null}
        <Form.Item
          label={t.review.noteLabel}
          htmlFor={noteId}
          required
          style={{ marginBottom: 12 }}
          validateStatus={draft.error === undefined ? '' : 'error'}
          help={
            draft.error === undefined ? undefined : (
              <span role="alert" style={{ color: token.colorError }}>
                {draft.error}
              </span>
            )
          }
        >
          <Input.TextArea
            id={noteId}
            rows={3}
            value={draft.note}
            // Counted as the contract counts it (code points after trimming); not cut off, so a
            // pasted note over the limit stays visible and is refused with noteTooLong.
            count={{ show: true, max: NOTE_MAX, strategy: noteLength }}
            placeholder={rejecting ? t.review.rejectNotePlaceholder : t.review.notePlaceholder}
            onChange={(event) => onChange({ note: event.target.value, error: undefined })}
          />
        </Form.Item>
        <Flex align="center" justify="space-between" gap={12} wrap>
          {rejecting ? (
            <span />
          ) : (
            <Button
              type="link"
              size="small"
              aria-label={t.review.prefillName}
              style={{ paddingInline: 0 }}
              disabled={busy}
              onClick={() => onChange({ note: t.review.prefill, error: undefined })}
            >
              {t.review.prefillName}
            </Button>
          )}
          {rejecting ? (
            <Flex gap={12}>
              <Button
                disabled={busy}
                onClick={() => onChange({ mode: 'approve', reason: undefined, error: undefined })}
              >
                {t.review.cancel}
              </Button>
              <Button type="primary" danger disabled={busy} onClick={() => onSubmit('reject')}>
                {t.review.confirmReject}
              </Button>
            </Flex>
          ) : (
            <Flex gap={12}>
              <Button
                danger
                disabled={busy}
                onClick={() => onChange({ mode: 'reject', error: undefined })}
              >
                {t.review.reject}
              </Button>
              <Button type="primary" disabled={busy} onClick={() => onSubmit('approve')}>
                {t.review.approve}
              </Button>
            </Flex>
          )}
        </Flex>
      </Form>
    </Card>
  );
}
