import * as bridgeSdk from '@couli/bridge-sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Skeleton } from '../../../../components/base/index.ts';
import { RetryPage } from '../../../../components/retry/index.ts';
import { useApi, type AppApiBridge } from '../../../../shared/api/app-api.ts';
import type { H5ApiClient } from '../../../../shared/api/index.ts';
import { findOrderTexts } from '../../../../texts/find-order.ts';
import { Component as PagePending } from '../page-pending.tsx';
import { ClaimForm } from './claim-form.tsx';
import { ClaimRecords, RECORDS_KEY, type LocateTarget } from './claim-records.tsx';
import { CONFIG_KEYS, parseClaimConfig, type Claim, type ClaimPlatform } from './model.ts';
import { CARD, FOCUS, FOOTNOTE } from './parts.tsx';

export interface FindOrderPageProps {
  /** Injectable SDK facade; production uses @couli/bridge-sdk. */
  bridge?: AppApiBridge;
}

const DEFAULT_BRIDGE: AppApiBridge = {
  isInApp: bridgeSdk.isInApp,
  has: bridgeSdk.has,
  call: bridgeSdk.call,
  createH5TokenManager: bridgeSdk.createH5TokenManager,
};

/** 本页自有缓存（启动配置、当天置灰）的公共前缀；账号切换时整组删掉。 */
const PAGE_SCOPE = ['find-order'] as const;
const BOOT_KEY = [...PAGE_SCOPE, 'boot'] as const;

type Tab = 'apply' | 'records';

/**
 * 订单找回（F1-04b，路由 FindOrder）：进页经桥取 H5 令牌与 /v1/config（找回期限、按平台的指引链接、平台开关），
 * 「申请找回」经桥 net.signedRequest 提交 createOrderClaim，「找回记录」读 listOrderClaims。
 * 没有 API 客户端（App 外或未配置）时显示共用占位页，不发请求。
 */
export function FindOrderPage({ bridge = DEFAULT_BRIDGE }: FindOrderPageProps): ReactElement {
  const api = useApi();
  if (api === null) return <PagePending />;
  return <FindOrderContent api={api} bridge={bridge} />;
}

function Page({ children }: { children: ReactNode }): ReactElement {
  return (
    <main className="flex min-h-dvh min-w-0 flex-col gap-couli-3 bg-couli-background-canvas px-couli-4 pt-couli-2 font-couli-system text-couli-text-primary">
      {children}
    </main>
  );
}

function FindOrderContent({
  api,
  bridge,
}: {
  api: H5ApiClient;
  bridge: AppApiBridge;
}): ReactElement {
  const queryClient = useQueryClient();
  // 本页自己的令牌管理器只在内存里（BR-ID-32）；进页先取一次，取不到就显示加载失败，不自动重放。
  const [tokens] = useState(() => bridge.createH5TokenManager());
  // 账号代次：桥事件 auth.changed（同一 WebView 里退出、换号）时加一。查询键带上代次，
  // 表单与记录按代次重新挂载，切换前发出的请求结果只能落到已删除的旧键或已卸载的旧组件上。
  const [generation, setGeneration] = useState(0);
  const generationRef = useRef(0);
  const boot = useQuery({
    queryKey: [...BOOT_KEY, generation],
    queryFn: async () => {
      const getConfig = bridge.has('app.getConfig');
      if (getConfig === null) throw new Error('app.getConfig is not supported');
      const [, result] = await Promise.all([
        tokens.getToken({ forWrite: false }),
        bridge.call(getConfig, { keys: CONFIG_KEYS }),
      ]);
      return parseClaimConfig(result.values);
    },
    staleTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    refetchInterval: false,
    refetchIntervalInBackground: false,
  });

  const [tab, setTab] = useState<Tab>('apply');
  const [target, setTarget] = useState<LocateTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(
    () =>
      bridgeSdk.on('auth.changed', () => {
        generationRef.current += 1;
        tokens.invalidate();
        for (const queryKey of [PAGE_SCOPE, RECORDS_KEY]) {
          void queryClient.cancelQueries({ queryKey });
          queryClient.removeQueries({ queryKey });
        }
        setGeneration(generationRef.current);
        setTarget(null);
        setNotice(null);
      }),
    [queryClient, tokens],
  );

  const ids = { apply: useId(), records: useId(), applyPanel: useId(), recordsPanel: useId() };

  function select(next: Tab): void {
    if (next === tab) return;
    setTab(next);
    setTarget(null);
    setNotice(null);
  }

  function showRecords(next: LocateTarget, message: string | null): void {
    void queryClient.invalidateQueries({ queryKey: RECORDS_KEY, refetchType: 'none' });
    setTarget(next);
    setNotice(message);
    setTab('records');
  }

  // 回调绑定渲染时的代次：切换账号前提交、切换后才返回的结果不再切页签或定位。
  const bound = generation;
  function onCreated(claim: Claim): void {
    if (bound !== generationRef.current) return;
    showRecords({ claimId: claim.claim_id }, null);
  }

  function onDuplicate(platform: ClaimPlatform, orderNo: string, message: string): void {
    if (bound !== generationRef.current) return;
    showRecords({ platform, orderNo }, message);
  }

  const config = boot.data;
  if (config === undefined && boot.isError && !boot.isFetching) {
    return <RetryPage onRetry={() => void boot.refetch()} />;
  }
  if (config === undefined) {
    return (
      <Page>
        <div className={`${CARD} flex flex-col gap-couli-3 p-couli-4`}>
          <Skeleton width="30%" height="1.3125rem" />
          <Skeleton width="100%" height="2.75rem" />
          <Skeleton width="30%" height="1.3125rem" />
          <Skeleton width="100%" height="2.75rem" />
        </div>
      </Page>
    );
  }

  const tabs: { key: Tab; id: string; panel: string; label: string }[] = [
    { key: 'apply', id: ids.apply, panel: ids.applyPanel, label: findOrderTexts.tabApply },
    { key: 'records', id: ids.records, panel: ids.recordsPanel, label: findOrderTexts.tabRecords },
  ];

  return (
    <Page>
      <div
        role="tablist"
        aria-label={findOrderTexts.tabsLabel}
        className="flex gap-couli-1 rounded-couli-card bg-couli-background-muted p-couli-1"
      >
        {tabs.map((item) => {
          const selected = item.key === tab;
          return (
            <button
              key={item.key}
              id={item.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={item.panel}
              onClick={() => select(item.key)}
              className={`${FOCUS} min-h-11 flex-1 cursor-pointer rounded-couli-button ${FOOTNOTE} ${
                selected
                  ? 'bg-couli-background-surface font-couli-semibold text-couli-text-primary shadow-couli-card'
                  : 'font-couli-regular text-couli-text-secondary'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <section
        id={ids.applyPanel}
        role="tabpanel"
        aria-labelledby={ids.apply}
        hidden={tab !== 'apply'}
        className="flex flex-1 flex-col"
      >
        <ClaimForm
          key={generation}
          bridge={bridge}
          config={config}
          onCreated={onCreated}
          onDuplicate={onDuplicate}
        />
      </section>
      {tab === 'records' ? (
        <section
          id={ids.recordsPanel}
          role="tabpanel"
          aria-labelledby={ids.records}
          className="flex flex-1 flex-col pb-couli-6"
        >
          <ClaimRecords
            key={generation}
            generation={generation}
            api={api}
            target={target}
            notice={notice}
            onLocated={() => setTarget(null)}
          />
        </section>
      ) : null}
    </Page>
  );
}
