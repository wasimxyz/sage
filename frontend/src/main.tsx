import "./dispose-shim";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@/components/app";
import { preloadChatLayout } from "@/components/chat-layout-loader";
import "./index.css";

// Sage opens on a new chat. Chat's module starts loading now, beside the
// lock and setup checks, so it is here when the app first draws and Chat
// shows without a spinner.
preloadChatLayout().catch(() => undefined);

const rootElement = document.querySelector("#root");
if (!rootElement) {
  throw new Error("Could not find the root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
