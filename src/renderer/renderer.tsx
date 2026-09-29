import { createRoot } from "react-dom/client";
import { Shell } from "./shell";
import "@xterm/xterm/css/xterm.css";

const host = document.getElementById("root");
if (!host) throw new Error("Missing renderer root");
const root = createRoot(host);
root.render(<Shell />);
window.addEventListener(
  "beforeunload",
  () => {
    root.unmount();
  },
  { once: true },
);
