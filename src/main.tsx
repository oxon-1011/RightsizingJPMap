import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import "./ui/styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html に #root の要素がない");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
