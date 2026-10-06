import { useEffect, useRef, useSyncExternalStore, type ReactElement } from 'react';
import { ConformanceController, runChildFrame } from './controller.ts';

/**
 * Tap rows render as buttons (`data-case-id`, labelled with the case id) that native UI tests
 * press to supply the user gesture; the selected subframe probe renders a hidden same-origin
 * iframe. Everything the suites assert lives in window.__RESULT__.
 */
function ConformancePage({ controller }: { controller: ConformanceController }): ReactElement {
  const result = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => controller.start(() => frameRef.current?.contentWindow ?? null), [controller]);
  const taps = result.cases.filter((row) => row.trigger === 'tap');
  return (
    <main className="min-h-dvh p-4" data-status={result.status}>
      {controller.frameSrc === null ? null : (
        <iframe
          ref={frameRef}
          src={controller.frameSrc}
          aria-hidden="true"
          tabIndex={-1}
          className="h-0 w-0 border-0"
        />
      )}
      <ul className="flex flex-col gap-2">
        {taps.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              data-case-id={row.id}
              data-pass={row.pass === null ? 'pending' : String(row.pass)}
              disabled={result.status !== 'done'}
              aria-disabled={result.status !== 'done'}
              className="w-full rounded border px-3 py-2 text-left text-sm"
              onClick={() => controller.tap(row.id)}
            >
              {row.id}
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}

/** `?frame=child`: the subframe probe only (负面用例 ②). */
function ChildFrame(): ReactElement {
  useEffect(() => runChildFrame(), []);
  return <main className="min-h-dvh" />;
}

/**
 * Reads the page URL once: `?frame=child` renders the subframe probe; otherwise `?cases=a,b`
 * selects rows (none → all auto rows run and all tap rows render). window.__RESULT__ exists as
 * soon as this returns.
 */
export function createConformanceShell(): ReactElement {
  const { search, pathname } = window.location;
  if (new URLSearchParams(search).get('frame') === 'child') return <ChildFrame />;
  return <ConformancePage controller={new ConformanceController(search, pathname)} />;
}
