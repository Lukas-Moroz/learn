import { useCallback, useEffect, useState } from "react";
import { api, type Status } from "./api.ts";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { ShellContext } from "./components/TopBar.tsx";
import { ConceptsPage } from "./pages/ConceptsPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { LessonPage } from "./pages/LessonPage.tsx";
import { ReviewPage } from "./pages/ReviewPage.tsx";

type Theme = "light" | "dark" | "system";

function readTheme(): Theme {
  try {
    return (localStorage.getItem("learn:theme") as Theme) || "system";
  } catch {
    return "system";
  }
}

function useHashRoute() {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => {
      setHash(location.hash || "#/");
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export function App() {
  const hash = useHashRoute();
  const [status, setStatus] = useState<Status | null>(null);
  const [settings, setSettings] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [toastMsg, setToast] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.status().then(setStatus).catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20_000);
    const es = new EventSource("/api/events");
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data);
        if (ev.type === "provider" || (ev.type === "job" && ev.status === "failed")) refresh();
      } catch {
        // ignore
      }
    };
    return () => {
      clearInterval(t);
      es.close();
    };
  }, [refresh]);

  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("learn:theme", theme);
    } catch {
      // per-viewer convenience only
    }
  }, [theme]);

  const toast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((m) => (m === msg ? null : m)), 4000);
  }, []);

  const lesson = /^#\/lesson\/([\w-]+)/.exec(hash)?.[1];
  const page = lesson ? <LessonPage key={lesson} lessonId={lesson} /> : hash.startsWith("#/review") ? <ReviewPage /> : hash.startsWith("#/concepts") ? <ConceptsPage /> : <HomePage />;

  return (
    <ShellContext.Provider
      value={{
        status,
        openSettings: () => setSettings(true),
        theme,
        cycleTheme: () => setTheme((t) => (t === "system" ? "light" : t === "light" ? "dark" : "system")),
        toast,
      }}
    >
      {page}
      {settings && <SettingsDialog status={status} onClose={() => setSettings(false)} refresh={refresh} />}
      {toastMsg && (
        <div className="toast" role="status">
          {toastMsg}
        </div>
      )}
    </ShellContext.Provider>
  );
}
