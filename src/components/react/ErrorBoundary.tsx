/* ------------------------------------------------------------------ *
 * The last screen.
 *
 * The whole product is one `client:only` island, so an uncaught render throw
 * takes the entire page with it and leaves true black — which is exactly what
 * this app looks like while it is working. That is the worst failure this
 * codebase can have: there is no server, so nothing is logged anywhere, and to
 * somebody whose only copy of a year of appointments lives in this browser's
 * `localStorage`, a black screen and a calendar that has been eaten are the
 * same picture.
 *
 * So the fallback's job is not to apologise. It is to say the data is still
 * there and put the one button that proves it within reach, before the user
 * does the thing people do to a broken web app and clears the site.
 * ------------------------------------------------------------------ */

import { Component, type ErrorInfo, type ReactNode } from "react";

import { exportBackup } from "@/lib/backup";
import { store } from "@/lib/store";

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // There is nowhere to send this — no server, by design — so the console is
    // the whole of the telemetry. Worth keeping: it is the only artefact a
    // person can paste into an issue.
    console.error("circal crashed", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    // `h-dvh`, not `h-full`: the shell that owns the app's height is the thing
    // that just threw, so this cannot inherit one from it.
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-void p-6">
        <div className="w-[380px] max-w-full rounded-[14px] border border-hairline bg-surface p-4">
          <p className="label text-ink-3">Something broke</p>
          <p className="caption mt-2">
            The dial stopped drawing. Your events are untouched — they live in this browser, not in
            the part that failed. Save a copy before you do anything else.
          </p>
          <div className="mt-4 flex gap-2">
            {/* Reading the store rather than a prop: the tree that held the
                snapshot is the tree that just threw, and this one is not
                allowed to depend on any of it. */}
            <button
              type="button"
              className="flex-1 rounded-[9px] border border-hairline bg-surface-2 px-3 py-2 text-[12px] text-ink transition-colors hover:bg-white/10"
              onClick={() => void exportBackup(store.snapshot())}
            >
              Download backup
            </button>
            <button
              type="button"
              className="flex-1 rounded-[9px] border border-hairline px-3 py-2 text-[12px] text-ink-2 transition-colors hover:text-ink"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
          {/* The message, quietly, in the mono voice the app uses for anything
              it did not write itself. It is the only thing a bug report can
              carry, and hiding it helps nobody — which is also why it is
              `ink-3` and not `ink-4`: `ink-4` is ticks and disabled, ~1.5:1 on
              black, and this is text somebody has to be able to copy. */}
          <p className="mt-3 truncate font-mono text-[11px] text-ink-3" title={error.message}>
            {error.message || String(error)}
          </p>
        </div>
      </div>
    );
  }
}
