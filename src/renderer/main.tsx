import { createRoot } from "react-dom/client";
// Hash-based: Electron serves the renderer over file://, where path-based
// history has no server to fall back to. The hash survives refresh in both
// dev (vite) and packaged loads, and leaves ?apiBase= untouched.
import { HashRouter } from "react-router";
import App from "./App.tsx";
import { initTheme } from "./theme.ts";
import "./styles.css";

initTheme();
createRoot(document.getElementById("root")!).render(
  <HashRouter>
    <App />
  </HashRouter>,
);
