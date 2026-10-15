import { useEffect, useRef, useState } from "react";
import { api, type Status } from "../api.ts";
import { Modal } from "./Modal.tsx";
import { providerName } from "./TopBar.tsx";

export function SettingsDialog({ status, onClose, refresh }: { status: Status | null; onClose: () => void; refresh: () => void }) {
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const openai = status?.providers.find((p) => p.id === "openai");
  const claude = status?.providers.find((p) => p.id === "claude");
  const mock = status?.providers.find((p) => p.id === "mock");
  const active = status?.providers.find((p) => p.id === status.active);

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
    <Modal label="AI providers" className="dialog" onClose={onClose} initialFocus={closeButtonRef}>
      <div className="row">
        <h2 style={{ margin: 0, flex: 1 }}>AI providers</h2>
        <button ref={closeButtonRef} className="btn small" onClick={onClose} aria-label="Close settings">
          <span aria-hidden>✕</span>
        </button>
      </div>
      {status && (
        <p className="row small active-provider">
          <span className={`dot ${status.paused ? "bad" : active?.ready ? "ok" : "warn"}`} />
          <span>
            {status.paused ? "Paused" : "Using"} <b>{providerName(status.active)}</b>
            {active && !status.paused ? ` · ${active.id === "mock" ? "built-in sample lessons, no AI" : active.message}` : ""}
          </span>
        </p>
      )}
      {status?.paused && (
        <div className="banner warn small">
          <span style={{ flex: 1 }}>Paused: {status.paused.reason}</span>
          <button className="btn small" onClick={() => act(api.resume)}>
            Try again
          </button>
        </div>
      )}
      {forced && <div className="banner warn small">This server was started with LEARN_PROVIDER={status!.active}; that overrides the choice below.</div>}

      {openai && (
        <div className="provider">
          <div className="row">
            <span className={`dot ${openai.ready ? "ok" : openai.state === "connecting" ? "warn" : "bad"}`} />
            <b style={{ flex: 1 }}>{openai.label}</b>
            <label className="row small">
              <input type="radio" name="primary" aria-label="Use ChatGPT plan" checked={status!.settings.primary === "openai"} onChange={() => act(() => api.setProviders({ primary: "openai" }))} /> Use
            </label>
          </div>
          <div className="small muted">
            {openai.account ? `${openai.account} · ` : ""}
            {openai.message}
          </div>
          <div className="row" style={{ marginTop: "0.5rem" }}>
            {openai.state === "not_installed" ? null : openai.state === "connecting" ? (
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
          <details className="more" open={openai.state === "not_installed" || undefined}>
            <summary>Setup details</summary>
            {openai.state === "not_installed" && (
              <p>
                Install the ChatGPT connector, then reopen Settings: <code>cd app && npm run setup:openai</code>
              </p>
            )}
            <p>Uses your ChatGPT plan's shared usage allowance (the Codex/Work allowance, not unlimited chat).</p>
          </details>
        </div>
      )}

      {claude && (
        <div className="provider">
          <div className="row">
            <span className={`dot ${claude.ready ? "ok" : claude.state === "not_enabled" ? "" : "bad"}`} />
            <b style={{ flex: 1 }}>{claude.label}</b>
          </div>
          <div className="small muted">
            {claude.account ? `${claude.account} · ` : ""}
            {claude.message}
          </div>
          <label className="row small" style={{ marginTop: "0.5rem" }}>
            <input type="checkbox" checked={status!.settings.claudeFallback} onChange={(e) => act(() => api.setProviders({ claudeFallback: e.target.checked }))} />
            Use as a fallback when the ChatGPT plan hits its limit
          </label>
          <details className="more">
            <summary>Setup details</summary>
            <p>
              Learn runs your own logged-in <code>claude</code> CLI as a plain text generator; it never reads your Claude credentials. It refuses to run if the CLI is using an API key, a cloud account,
              or paid extra usage.
            </p>
          </details>
        </div>
      )}

      {mock && (
        <div className="provider">
          <div className="row">
            <span className="dot ok" />
            <b style={{ flex: 1 }}>Demo mode</b>
            <label className="row small">
              <input type="radio" name="primary" aria-label="Use Demo mode" checked={status!.settings.primary === "mock"} onChange={() => act(() => api.setProviders({ primary: "mock" }))} /> Use
            </label>
          </div>
          <div className="small muted">Built-in sample lessons (probability → Markov models) for trying the app. Uses no AI.</div>
        </div>
      )}

      {status?.generation && (
        <div className="provider">
          <label className="row small">
            <input type="checkbox" checked={status.generation.prefetch} disabled={busy} onChange={(e) => act(() => api.setGeneration({ prefetch: e.target.checked }))} />
            <b>Prepare the next step in advance</b>
          </label>
          <div className="small muted">Writes the next explanation or question while you read, so Continue shows it at once. It may use extra AI requests (for steps you never reach).</div>
        </div>
      )}

      <details className="more">
        <summary>Billing and data</summary>
        <p>Learn only uses subscriptions you already pay for. It never calls a pay-as-you-go API, and if your plan runs out it pauses instead of switching billing.</p>
        <p>
          Your data: <code>{status?.dataDir}</code>
        </p>
      </details>
    </Modal>
  );
}
