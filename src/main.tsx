import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { app } from "./app/instance";
import { App } from "./ui/App";
import "./ui/styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html に #root の要素がない");
}

// 描く前に、置き場所、書き込みのロック、目録の読み込みを始める。失敗は app がコンソールに出す
void app.boot();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
