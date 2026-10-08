import { createContext, useContext, type ReactNode } from "react";
import type { Status } from "../api.ts";

export interface Shell {
  status: Status | null;
  openSettings: () => void;
  theme: "light" | "dark" | "system";
  cycleTheme: () => void;
  toast: (msg: string) => void;
}
export const ShellContext = createContext<Shell>(null as unknown as Shell);
export const useShell = () => useContext(ShellContext);

export function ProviderPill() {
  const { status, openSettings } = useShell();
  if (!status) return null;
  const active = status.providers.find((p) => p.id === status.active);
  const cls = status.paused ? "bad" : active?.ready ? "ok" : "warn";
  const label = status.paused ? "Paused" : active ? (active.id === "mock" ? "Mock" : active.id === "openai" ? "ChatGPT" : "Claude") : "No provider";
  return (
    <button className="pill" onClick={openSettings} title={status.paused?.reason ?? active?.message ?? ""} style={{ cursor: "pointer" }}>
      <span className={`dot ${cls}`} /> {label}
    </button>
  );
}

export function TopBar({ crumbs, children, progress }: { crumbs?: ReactNode; children?: ReactNode; progress?: number }) {
  const { openSettings, theme, cycleTheme } = useShell();
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href="#/">
          <span className="brand-mark" aria-hidden>
            L
          </span>
          Learn
        </a>
        <div className="crumbs">{crumbs}</div>
        <nav className="topbar-actions" aria-label="App">
          <a className="btn ghost small" href="#/review">
            Review
          </a>
          <a className="btn ghost small" href="#/concepts">
            Concepts
          </a>
          <ProviderPill />
          <button className="btn ghost small" onClick={cycleTheme} aria-label={`Theme: ${theme}. Change theme`} title={`Theme: ${theme}`}>
            {theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"}
          </button>
          <button className="btn ghost small" onClick={openSettings} aria-label="Settings">
            ⚙
          </button>
        </nav>
      </div>
      {children}
      {progress !== undefined && (
        <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
    </header>
  );
}
