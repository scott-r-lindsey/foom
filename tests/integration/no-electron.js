const assert = require("node:assert/strict");
const { registerHooks } = require("node:module");
assert.equal(process.versions.electron, undefined, "Integration lane must run in real Node");
registerHooks({
  resolve(specifier, context, nextResolve) {
    assert.ok(!/^electron(?:\/|$)/.test(specifier), "Electron must never load in this lane");
    return nextResolve(specifier, context);
  },
});
