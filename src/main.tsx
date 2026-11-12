import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { initTheme } from "./lib/theme";
import { Toaster } from "./components/ui/sonner";
import "./index.css";

// 首帧前按持久化模式应用主题，避免启动时闪一下错误的明暗
initTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
    <Toaster />
  </React.StrictMode>
);
