import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, type Status } from "./api.ts";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { ShellContext } from "./components/TopBar.tsx";
import { ConceptsPage } from "./pages/ConceptsPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { LessonPage } from "./pages/LessonPage.tsx";
import { PracticeProblemPage } from "./pages/PracticeProblemPage.tsx";
import { PracticeSetPage } from "./pages/PracticeSetPage.tsx";
import { ReviewPage } from "./pages/ReviewPage.tsx";
import { relayFollowUpEvent, relayJobEvent, relayLessonEvent } from "./liveJobs.ts";
import { relayPracticeEvent } from "./practiceLive.ts";

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
        if (ev.type === "practice") relayPracticeEvent(ev);
        if (ev.type === "job") relayJobEvent(ev);
        if (ev.type === "lesson") relayLessonEvent(ev);
        if (ev.type === "followup") relayFollowUpEvent(ev);
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
  // #/practice/:setId lists a set's problems; #/practice/:setId/:problemId works one problem.
  const [, practiceSet, practiceProblem] = /^#\/practice\/([\w-]+)(?:\/([\w-]+))?/.exec(hash) ?? [];
  const page = lesson ? (
    <LessonPage key={lesson} lessonId={lesson} />
  ) : practiceProblem ? (
    <PracticeProblemPage key={practiceProblem} setId={practiceSet} problemId={practiceProblem} />
  ) : practiceSet ? (
    <PracticeSetPage key={practiceSet} setId={practiceSet} />
  ) : hash.startsWith("#/review") ? (
    <ReviewPage />
  ) : hash.startsWith("#/concepts") ? (
    <ConceptsPage />
  ) : (
    <HomePage />
  );

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
      {/* Outside #root so it is still announced while a modal makes #root inert. The live region stays mounted. */}
      {createPortal(
        <div className="toast-region" role="status">
          {toastMsg && <div className="toast">{toastMsg}</div>}
        </div>,
        document.body,
      )}
    </ShellContext.Provider>
  );
}
