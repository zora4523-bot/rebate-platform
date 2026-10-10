// antd Form.Item (grid Row) and Steps subscribe to `window.matchMedia` for breakpoints. Browsers
// always provide it; a DOM without a media-query API (jsdom, pre-rendering) gets a never-matching
// stand-in so the login page still renders. It never replaces an existing implementation.
const noop = (): void => undefined;

export function ensureMatchMedia(): void {
  if (typeof window === 'undefined' || typeof window.matchMedia === 'function') return;
  window.matchMedia = (media: string): MediaQueryList => ({
    matches: false,
    media,
    onchange: null,
    addListener: noop,
    removeListener: noop,
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => false,
  });
}
