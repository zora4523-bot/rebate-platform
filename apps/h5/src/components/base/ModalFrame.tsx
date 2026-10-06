import {
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ACTION_IN_ROW,
  ACTION_ROW,
  FOCUS_RING,
  LAYER,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from './styles.ts';
import type { ModalProps } from './types.ts';

export type ModalVariant = 'dialog' | 'sheet';

/** Open modals, innermost last: only the top one handles Escape and Tab. */
const openModals: object[] = [];

const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'iframe',
  'summary',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[tabindex]',
].join(',');

function isRendered(element: Element, boundary: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement && node.hidden) return false;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (node === boundary) break;
  }
  return true;
}

/** Tabbable descendants in DOM order, skipping disabled, inert and hidden ones. */
function tabbables(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(':disabled') &&
      element.closest('[inert]') === null &&
      isRendered(element, panel),
  );
}

function nextTabbable(panel: HTMLElement, backwards: boolean): HTMLElement | undefined {
  const items = tabbables(panel);
  const active = document.activeElement;
  if (active === null || !panel.contains(active)) return backwards ? items.at(-1) : items[0];
  if (backwards) {
    const before = items.filter(
      (item) => item.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    return before.at(-1) ?? items.at(-1);
  }
  const after = items.find(
    (item) => active.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  return after ?? items[0];
}

// Dialog: centred card, at most viewport − 2 × (safe area + 24) tall (a11y spec §4).
const DIALOG_HEIGHT: CSSProperties = {
  maxHeight:
    'calc(100dvh - 2 * (max(env(safe-area-inset-top, 0px), env(safe-area-inset-bottom, 0px)) + var(--space-6)))',
};
// Sheet: bottom panel, at most viewport − top safe area − 24; 34 bottom inset or the safe area.
const SHEET_FRAME: CSSProperties = {
  maxHeight: 'calc(100dvh - env(safe-area-inset-top, 0px) - var(--space-6))',
  paddingBottom: 'max(34px, env(safe-area-inset-bottom, 0px))',
};

const VARIANT = {
  dialog: {
    root: 'flex items-center justify-center px-couli-6',
    panel: 'w-full rounded-couli-card p-couli-5',
    panelStyle: DIALOG_HEIGHT,
    title: 'px-couli-8 text-center text-couli-body leading-couli-body',
    close: 'top-couli-2 right-couli-2',
    actions: '',
    // A full-width divider above the buttons while the body scrolls (a11y spec §4).
    divider:
      'data-scrollable:-mx-couli-5 data-scrollable:border-t data-scrollable:border-couli-border-subtle data-scrollable:px-couli-5 data-scrollable:pt-couli-3',
  },
  sheet: {
    root: 'flex flex-col justify-end',
    panel: 'w-full rounded-t-couli-panel px-couli-4 pt-couli-5',
    panelStyle: SHEET_FRAME,
    // Sheet titles use the title size, 22/28.6 (ProductAuthSheet, AdaptShortAuthSheet).
    title: 'pr-couli-8 text-couli-title leading-couli-title',
    close: 'top-couli-2 right-couli-1',
    actions: 'pt-couli-2',
    divider:
      'data-scrollable:-mx-couli-4 data-scrollable:border-t data-scrollable:border-couli-border-subtle data-scrollable:px-couli-4 data-scrollable:pt-couli-3',
  },
} as const;

function CloseIcon(): ReactElement {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

interface ModalFrameProps extends ModalProps {
  variant: ModalVariant;
}

/**
 * Shared modal behaviour for Dialog and Sheet: portal into `portalContainer` (default
 * document.body), focus the title on open, keep Tab inside, close on Escape / backdrop as allowed,
 * and return focus to the previously focused control when closed or unmounted.
 */
export function ModalFrame(props: ModalFrameProps): ReactElement | null {
  const {
    variant,
    open,
    title,
    description,
    closeLabel,
    onClose,
    children,
    primaryAction,
    secondaryAction,
    dismissible = true,
    closeOnBackdrop = true,
    portalContainer,
  } = props;
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);

  const onKeyDown = useEffectEvent((event: KeyboardEvent, panel: HTMLElement) => {
    if (event.key === 'Escape') {
      if (!dismissible || event.isComposing) return;
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = nextTabbable(panel, event.shiftKey);
    event.preventDefault();
    target?.focus();
  });

  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel === null) return;
    const token = {};
    openModals.push(token);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    titleRef.current?.focus();
    const listener = (event: KeyboardEvent) => {
      if (openModals.at(-1) === token) onKeyDown(event, panel);
    };
    document.addEventListener('keydown', listener);
    return () => {
      document.removeEventListener('keydown', listener);
      openModals.splice(openModals.indexOf(token), 1);
      // Return focus unless the caller already moved it somewhere else on purpose.
      const active = document.activeElement;
      const focusLost = active === null || active === document.body || panel.contains(active);
      if (focusLost && previous !== null && previous.isConnected) previous.focus();
    };
  }, [open]);

  // Track whether the body overflows: the body box follows the viewport, the content box follows
  // the caller's content. Environments without ResizeObserver simply show no divider.
  useLayoutEffect(() => {
    if (!open) return;
    const body = bodyRef.current;
    const content = contentRef.current;
    if (body === null || content === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setScrollable(body.scrollHeight > body.clientHeight);
    });
    observer.observe(body);
    observer.observe(content);
    return () => observer.disconnect();
  }, [open]);

  if (!open) return null;
  const style = VARIANT[variant];
  const hasActions = primaryAction !== undefined || secondaryAction !== undefined;
  const allowBackdrop = dismissible && closeOnBackdrop;

  return createPortal(
    <div className={`${LAYER} inset-0 ${style.root}`}>
      <div
        data-slot="modal-backdrop"
        aria-hidden="true"
        className="absolute inset-0 bg-couli-text-primary/40"
        onClick={allowBackdrop ? onClose : undefined}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        className={`relative flex flex-col gap-couli-4 bg-couli-background-surface text-couli-text-primary [box-shadow:var(--shadow-floating)] ${style.panel}`}
        style={style.panelStyle}
      >
        {variant === 'sheet' ? (
          <div
            data-slot="sheet-handle"
            aria-hidden="true"
            className="absolute top-couli-2 left-1/2 h-couli-1 w-9 -translate-x-1/2 rounded-couli-pill bg-couli-border-subtle"
          />
        ) : null}
        <h2
          ref={titleRef}
          id={titleId}
          tabIndex={-1}
          className={`flex-none font-couli-semibold outline-none ${style.title}`}
        >
          {title}
        </h2>
        <button
          type="button"
          aria-label={closeLabel}
          className={`absolute flex size-couli-interaction-target-minimum cursor-pointer items-center justify-center rounded-couli-button text-couli-text-secondary ${FOCUS_RING} ${style.close}`}
          onClick={onClose}
        >
          <CloseIcon />
        </button>
        <div
          ref={bodyRef}
          data-slot="modal-body"
          className="-m-couli-1 min-h-0 overflow-y-auto p-couli-1 text-couli-footnote leading-couli-footnote"
        >
          <div ref={contentRef}>
            {description === undefined ? null : (
              <p id={descriptionId} className="mb-couli-3 last:mb-0">
                {description}
              </p>
            )}
            {children}
          </div>
        </div>
        {hasActions ? (
          <div
            data-slot="modal-actions"
            data-scrollable={scrollable ? '' : undefined}
            className={`${ACTION_ROW} ${style.actions} ${style.divider}`}
          >
            {secondaryAction === undefined ? null : (
              <button
                type="button"
                className={`${ACTION_IN_ROW} ${SECONDARY_BUTTON}`}
                onClick={secondaryAction.onClick}
              >
                {secondaryAction.label}
              </button>
            )}
            {primaryAction === undefined ? null : (
              <button
                type="button"
                className={`${ACTION_IN_ROW} ${PRIMARY_BUTTON}`}
                onClick={primaryAction.onClick}
              >
                {primaryAction.label}
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>,
    portalContainer ?? document.body,
  );
}
