import { useEffect, useRef, useState } from "react";
import { api, type Status } from "../api.ts";

export function SettingsDialog({ status, onClose, refresh }: { status: Status | null; onClose: () => void; refresh: () => void }) {
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  const openai = status?.providers.find((p) => p.id === "openai");
  const claude = status?.providers.find((p) => p.id === "claude");
  const mock = status?.providers.find((p) => p.id === "mock");

  useEffect(() => first.current?.focus(), []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  useEffect(() => {
    if (openai?.state === "ready" || openai?.state === "error") api.openaiModels().then(setModels).catch(() => setModels([]));
  }, [openai?.state]);
  // While a browser sign-in is in progress, poll for completion.
  useEffect(() => {
    if (openai?.state !== "connecting") return;
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [openai?.state, refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const forced = status && status.active !== status.settings.primary;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="dialog" role="dialog" aria-label="AI providers">
        <div className="row">
          <h2 style={{ margin: 0, flex: 1 }}>AI providers</h2>
          <button ref={first} className="btn small" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </div>
        <p className="muted small">
          Learn only uses subscriptions you already pay for. It never calls a pay-as-you-go API, and if your plan runs out it pauses instead of switching billing.
        </p>
        {forced && <div className="banner warn small">This server was started with LEARN_PROVIDER={status!.active}; that overrides the choice below.</div>}
        {status?.paused && (
          <div className="banner warn small">
            <span style={{ flex: 1 }}>Paused: {status.paused.reason}</span>
            <button className="btn small" onClick={() => act(api.resume)}>
              Try again
            </button>
          </div>
        )}

        {openai && (
          <div className="provider">
            <div className="row">
              <span className={`dot ${openai.ready ? "ok" : openai.state === "connecting" ? "warn" : "bad"}`} />
              <b style={{ flex: 1 }}>{openai.label}</b>
              <label className="row small">
                <input type="radio" name="primary" checked={status!.settings.primary === "openai"} onChange={() => act(() => api.setProviders({ primary: "openai" }))} /> Use
              </label>
            </div>
            <div className="small muted">{openai.account ? `${openai.account} · ` : ""}{openai.message}</div>
            <div className="small muted">Uses your ChatGPT plan's shared usage allowance (the Codex/Work allowance, not unlimited chat).</div>
            <div className="row" style={{ marginTop: "0.5rem" }}>
              {openai.state === "not_installed" ? (
                <code className="small">cd app && npm run setup:openai</code>
              ) : openai.state === "connecting" ? (
                <button className="btn small" onClick={() => act(api.openaiCancel)}>
                  Cancel sign-in
                </button>
              ) : openai.state === "signed_out" ? (
                <button className="btn small primary" disabled={busy} onClick={() => act(api.openaiSignIn)}>
                  Sign in with ChatGPT
                </button>
              ) : (
                <>
                  {models.length > 0 && (
                    <select aria-label="ChatGPT model" value={openai.model ?? ""} onChange={(e) => act(() => api.setOpenaiModel(e.target.value))} style={{ width: "auto" }}>
                      {!openai.model && <option value="">Choose a model</option>}
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <button className="btn small" onClick={() => act(api.openaiDisconnect)}>
                    Disconnect
                  </button>
                </>
              )}
              {openai.usageUrl && (
                <a className="btn small ghost" href={openai.usageUrl} target="_blank" rel="noreferrer">
                  Usage
                </a>
              )}
            </div>
          </div>
        )}

        {claude && (
          <div className="provider">
            <div className="row">
              <span className={`dot ${claude.ready ? "ok" : claude.state === "not_enabled" ? "" : "bad"}`} />
              <b style={{ flex: 1 }}>{claude.label}</b>
            </div>
            <div className="small muted">{claude.account ? `${claude.account} · ` : ""}{claude.message}</div>
            <label className="row small" style={{ marginTop: "0.5rem", alignItems: "flex-start" }}>
              <input type="checkbox" checked={status!.settings.claudeFallback} onChange={(e) => act(() => api.setProviders({ claudeFallback: e.target.checked }))} style={{ marginTop: "0.3rem" }} />
              <span>
                Allow as a fallback when the ChatGPT plan hits its limit. Learn runs your own logged-in <code>claude</code> CLI as a plain text generator; it never reads your Claude credentials. It refuses to run if the CLI is using an API key, a cloud account, or paid extra usage.
              </span>
            </label>
          </div>
        )}

        {mock && (
          <div className="provider">
            <div className="row">
              <span className="dot ok" />
              <b style={{ flex: 1 }}>{mock.label}</b>
              <label className="row small">
                <input type="radio" name="primary" checked={status!.settings.primary === "mock"} onChange={() => act(() => api.setProviders({ primary: "mock" }))} /> Use
              </label>
            </div>
            <div className="small muted">Deterministic built-in content (probability → Markov models). For trying the app and for development; uses no AI.</div>
          </div>
        )}
        <p className="muted small">Your data: {status?.dataDir}</p>
      </div>
    </>
  );
}
