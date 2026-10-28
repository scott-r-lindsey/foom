// Preload in every test runner, before tests or their imports can launch Git.
const { gitEnvironment } = require("./git.js");
for (const key of Object.keys(process.env)) {
  if (key.toUpperCase().startsWith("GIT_")) delete process.env[key];
}
Object.assign(process.env, gitEnvironment());

// jsdom has no native dialog methods; real modal/focus behavior is covered in Electron.
if (typeof globalThis.HTMLDialogElement !== "undefined") {
  globalThis.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  globalThis.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
}

// jsdom lacks the HTML popover API; Electron covers top-layer dismissal and focus.
if (typeof globalThis.HTMLElement !== "undefined") {
  globalThis.HTMLElement.prototype.togglePopover = function () {
    const open = !this.hasAttribute("data-test-popover-open");
    this.toggleAttribute("data-test-popover-open", open);
    this.style.display = open ? "block" : "none";
    this.dispatchEvent(Object.assign(new Event("toggle"), { newState: open ? "open" : "closed" }));
  };
  globalThis.HTMLElement.prototype.hidePopover = function () {
    this.removeAttribute("data-test-popover-open");
    this.style.display = "none";
    this.dispatchEvent(Object.assign(new Event("toggle"), { newState: "closed" }));
  };
}
