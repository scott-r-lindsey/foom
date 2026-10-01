import { createRoot } from "react-dom/client";
import { App } from "./app";
import "@xterm/xterm/css/xterm.css";

const host = document.getElementById("root");
if (!host) throw new Error("Missing renderer root");
const root = createRoot(host);
root.render(<App />);
window.addEventListener(
  "beforeunload",
  () => {
    root.unmount();
  },
  { once: true },
);
