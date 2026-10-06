// Shared class lists for the base components. Token aliases only (@couli/ui-tokens tailwind.css).

/** Keyboard focus ring: focus colour, focus width and focus offset tokens (`:focus-visible`). */
export const FOCUS_RING =
  'focus-visible:outline-solid focus-visible:outline-[length:var(--focus-width)] focus-visible:outline-offset-[var(--focus-offset)] focus-visible:outline-couli-focus-ring';

const BUTTON_BASE = `min-h-couli-component-button-min-height cursor-pointer rounded-couli-button px-couli-component-button-padding-inline py-couli-component-button-padding-block text-couli-body leading-couli-body ${FOCUS_RING}`;

/** Main button: brand fill, inverse text 17/600 (GUIDE §3). */
export const PRIMARY_BUTTON = `${BUTTON_BASE} bg-couli-button-primary-default-background font-couli-semibold text-couli-button-primary-default-text active:bg-couli-button-primary-pressed-background active:text-couli-button-primary-pressed-text`;

/** Secondary button: same size, surface fill with a control border, 17/500. */
export const SECONDARY_BUTTON = `${BUTTON_BASE} border border-couli-border-control bg-couli-background-surface font-couli-medium text-couli-text-primary active:bg-couli-background-muted`;

/** Button row inside dialogs and sheets: equal widths, wraps with the main button on top. */
export const ACTION_ROW = 'flex flex-none flex-wrap-reverse gap-couli-3';
export const ACTION_IN_ROW = 'flex-1 basis-0 min-w-max whitespace-nowrap';

/** Overlay layers: fixed, above page content, token font family. */
export const LAYER = 'fixed z-50 font-couli-system';
