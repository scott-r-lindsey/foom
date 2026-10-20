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
