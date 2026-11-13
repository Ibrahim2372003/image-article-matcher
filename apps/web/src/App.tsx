import { useEffect, useState } from "react";

type State = { kind: "loading" } | { kind: "ok"; version: string } | { kind: "error"; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });
  useEffect(() => {
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { version: string }) => setState({ kind: "ok", version: j.version }))
      .catch((e: unknown) => setState({ kind: "error", message: e instanceof Error ? e.message : "Unknown error" }));
  }, []);
  return (
    <main style={{ maxWidth: 720, margin: "2rem auto", padding: "0 1rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>Image–Article Matcher</h1>
      <p>AI Content Mismatch Guard. Submission and review UI arrive in milestone 6.</p>
      <p role="status" aria-live="polite">
        {state.kind === "loading" && "Checking API…"}
        {state.kind === "ok" && `API reachable (v${state.version})`}
        {state.kind === "error" && `API unreachable: ${state.message}`}
      </p>
    </main>
  );
}
