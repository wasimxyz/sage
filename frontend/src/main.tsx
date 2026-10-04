import "./dispose-shim";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@/components/app";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Could not find the root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
