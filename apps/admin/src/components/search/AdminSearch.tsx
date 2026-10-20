// Top-bar search (design/specs/admin-search.md, F1-07h): one GET /admin/v1/search per Enter or
// magnifier click, never while typing. The server recognises the shape and trims the hits by
// order.view / user.lookup / fund.view, so no hit and no permission look the same here. A single
// user hit opens the user detail; order and withdrawal details are not built yet, so their hits
// stay in the candidate list (no fake page) and activating them keeps the current page.
import type { Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import { Dropdown, Flex, Input, List, Tag, Typography, message, theme } from 'antd';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { AdminApiError } from '../../providers/data/index.ts';
import { searchTexts as t } from '../../texts/search.ts';
import './search.css';

type Hit = Schema<'AdminSearchItem'>;
type SearchResult = Schema<'AdminSearch'>;

const SEARCH_URL = '/admin/v1/search';
const MAX_LENGTH = 64;
const INVALID_QUERY = 20001;

type Shown =
  | { readonly kind: 'none' }
  | { readonly kind: 'empty'; readonly query: string }
  | {
      readonly kind: 'hits';
      readonly query: string;
      readonly items: readonly Hit[];
      readonly truncated: boolean;
    };

const NONE: Shown = { kind: 'none' };

export interface AdminSearchProps {
  /** Opens the user detail (users menu) for a user hit. */
  readonly onOpenUser: (userId: string) => void;
}

export function AdminSearch({ onOpenUser }: AdminSearchProps): ReactElement {
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const [notice, contextHolder] = message.useMessage();
  const baseId = useId();
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [loading, setLoading] = useState(false);
  const [shown, setShown] = useState<Shown>(NONE);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // False from opening until rc-trigger has placed the popup: until then it sits off-screen
  // (left -1000vw), so it stays hidden and takes no focus.
  const [placed, setPlaced] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const close = useCallback((refocus: boolean) => {
    // The candidates leave at once (nothing stale stays focusable while the panel animates out).
    setOpen(false);
    setShown(NONE);
    if (refocus) inputRef.current?.focus({ preventScroll: true });
  }, []);

  // A press outside the search box and its panel closes the panel (focus stays where it went).
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('mousedown', outside, true);
    return () => document.removeEventListener('mousedown', outside, true);
  }, [open, close]);

  const submit = async (raw: string): Promise<void> => {
    if (inFlight.current) return;
    const query = raw.trim();
    if (query === '') return;
    // A new search remounts the list, so its focus lands in the fresh candidates.
    setOpen(false);
    setShown(NONE);
    if ([...query].length > MAX_LENGTH) {
      // Never truncated into another number: the whole input stays for the operator to fix.
      setInvalid(true);
      return;
    }
    setInvalid(false);
    inFlight.current = true;
    setLoading(true);
    try {
      const custom = getProvider().custom;
      if (custom === undefined) throw new Error('Missing custom data provider');
      const response = await custom<SearchResult>({
        url: SEARCH_URL,
        method: 'get',
        query: { q: query },
      });
      if (!alive.current) return;
      const { items, truncated } = response.data;
      const only = items.length === 1 ? items[0] : undefined;
      // Without a layout engine (zero-size anchor) rc-trigger never aligns: show the panel as is.
      setPlaced((anchorRef.current?.getBoundingClientRect().width ?? 0) === 0);
      if (only?.type === 'user') {
        onOpenUser(only.id);
      } else if (items.length === 0) {
        setShown({ kind: 'empty', query });
        setOpen(true);
      } else {
        setActive(0);
        setShown({ kind: 'hits', query, items, truncated });
        setOpen(true);
      }
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof AdminApiError && cause.code === INVALID_QUERY) setInvalid(true);
      else void notice.error(t.failed);
    } finally {
      inFlight.current = false;
      if (alive.current) setLoading(false);
    }
  };

  const activate = (hit: Hit): void => {
    // Order and withdrawal details are not online yet: the summary is all there is (no jump).
    if (hit.type !== 'user') return;
    close(false);
    onOpenUser(hit.id);
  };

  const onListKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!open || shown.kind !== 'hits') return;
    const count = shown.items.length;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (index + 1) % count);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (index - 1 + count) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const hit = shown.items[active];
      if (hit !== undefined) activate(hit);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      close(true);
    }
  };

  // The candidate list takes the focus when it appears (keyboard and screen readers start there).
  // The popup's portal joins the document after this ref is set (in the same commit), so the focus
  // waits for the next microtask.
  const focusList = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    if (node === null) return;
    queueMicrotask(() => {
      if (node.isConnected) node.focus({ preventScroll: true });
    });
  }, []);

  // Once placed (after rc-trigger's first alignment), the visible list takes the focus. A layout
  // effect runs in the same commit that reveals the panel, before any other script or paint, so the
  // list is never visible without holding the focus (a passive effect could run a task later).
  useLayoutEffect(() => {
    if (open && placed && shown.kind === 'hits') listRef.current?.focus({ preventScroll: true });
  }, [open, placed, shown]);

  // Passed through antd and rc-dropdown to rc-trigger (antd's DropdownProps lists neither):
  // onPopupAlign reports the placement; fresh re-renders a closing popup instead of keeping its
  // last content, so closed candidates leave the page at once.
  const triggerProps = { fresh: true, onPopupAlign: () => setPlaced(true) };

  const optionId = (index: number): string => `${baseId}-option-${index}`;

  const panelStyle = {
    background: token.colorBgElevated,
    borderRadius: token.borderRadiusLG,
    boxShadow: token.boxShadowSecondary,
    visibility: placed ? 'visible' : 'hidden',
  } as const;

  const renderPanel = (): ReactElement => {
    if (shown.kind === 'empty') {
      return (
        <div ref={panelRef} className="admin-search-panel admin-search-empty" style={panelStyle}>
          <Flex vertical gap={token.marginXS} role="status">
            <Typography.Text strong>{t.noHitTitle(shown.query)}</Typography.Text>
            <Typography.Text type="secondary">{t.noHitDescription}</Typography.Text>
            <Typography.Text type="secondary" className="admin-search-note">
              {t.noHitFooter}
            </Typography.Text>
          </Flex>
        </div>
      );
    }
    if (shown.kind !== 'hits') return <div ref={panelRef} />;
    return (
      <div ref={panelRef} className="admin-search-panel" style={panelStyle}>
        <Flex
          vertical
          ref={focusList}
          role="listbox"
          tabIndex={-1}
          aria-label={t.listLabel}
          aria-activedescendant={optionId(active)}
          className="admin-search-listbox"
          onKeyDown={onListKey}
        >
          <Typography.Text type="secondary" className="admin-search-head">
            {t.multiHeader(shown.query, shown.items.length)}
          </Typography.Text>
          <List
            dataSource={[...shown.items]}
            renderItem={(hit, index) => (
              <List.Item
                key={`${hit.type}:${hit.id}`}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                aria-label={t.optionName(hit.type, hit.id, hit.summary)}
                className="admin-search-option"
                {...(index === active ? { style: { background: token.controlItemBgActive } } : {})}
                onMouseEnter={() => setActive(index)}
                onClick={() => activate(hit)}
              >
                <Flex align="center" gap={token.marginSM} className="admin-search-option-row">
                  <Tag
                    bordered={false}
                    color={hit.type === 'user' ? 'default' : 'processing'}
                    className="admin-search-type"
                  >
                    {t.typeLabel(hit.type)}
                  </Tag>
                  <Typography.Text>{hit.summary}</Typography.Text>
                </Flex>
              </List.Item>
            )}
          />
          {shown.truncated ? (
            <Typography.Text type="warning" className="admin-search-note admin-search-truncated">
              {t.truncated}
            </Typography.Text>
          ) : null}
          <Typography.Text
            type="secondary"
            className="admin-search-note admin-search-foot"
            style={{ borderTop: `${token.lineWidth}px solid ${token.colorSplit}` }}
          >
            {t.footer}
          </Typography.Text>
        </Flex>
      </div>
    );
  };

  return (
    <Dropdown
      {...triggerProps}
      open={open}
      trigger={[]}
      placement="bottomRight"
      destroyOnHidden
      popupRender={renderPanel}
    >
      <Flex
        ref={anchorRef}
        role="search"
        aria-label={t.regionLabel}
        align="center"
        gap={token.marginXS}
        className="admin-search"
      >
        {contextHolder}
        {invalid ? (
          <Typography.Text type="danger" className="admin-search-note" role="alert">
            {t.invalid}
          </Typography.Text>
        ) : null}
        <Input.Search
          ref={(instance) => {
            inputRef.current = instance?.input ?? null;
          }}
          className="admin-search-input"
          // antd renders type="search" (role searchbox); the box is announced as a plain textbox.
          role="textbox"
          placeholder={t.placeholder}
          value={value}
          status={invalid ? 'error' : ''}
          loading={loading}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onInputKey}
          onSearch={(query) => void submit(query)}
        />
      </Flex>
    </Dropdown>
  );
}
