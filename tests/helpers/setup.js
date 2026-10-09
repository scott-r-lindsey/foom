// Preload in every test runner, before tests or their imports can launch Git.
const { gitEnvironment } = require("./git.js");
for (const key of Object.keys(process.env)) {
  if (key.toUpperCase().startsWith("GIT_")) delete process.env[key];
}
Object.assign(process.env, gitEnvironment());
