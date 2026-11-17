// Test-only cold-process fixture. No production Foom profile or agent CLI is opened.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createRequire } = require("node:module");
const { randomUUID } = require("node:crypto");
const [modulePath, root] = process.argv.slice(2);
const load = createRequire(modulePath);
app.setPath("userData", path.join(root, "electron-profile"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

async function measure() {
  // Driver/module loading and Electron readiness belong to the cold-start timer.
  const { ProfileDatabase } = load(modulePath);
  const { ViewChanges } = load("../view-changes.js");
  const { ViewRegistry } = load("../view-registry.js");
  const { executeDataCommand } = load("./commands.js");
  const tables = load("./schema.js");
  await app.whenReady();
  const channel = `sqlite-measurement-${randomUUID()}`;
  const page = path.join(root, "view.html");
  const script = path.join(root, "view.js");
  const preload = path.join(root, "preload.js");
  // The files were prepared before process launch; the channel is supplied as a
  // main-generated additional argument, rather than accepted from a renderer.
  const changes = new ViewChanges();
  const db = await ProfileDatabase.open(root, changes);
  const registry = new ViewRegistry(changes, () =>
    db.read((tx) =>
      tx
        .select()
        .from(tables.repositories)
        .orderBy(tables.repositories.path)
        .all()
        .map((row) => ({ path: row.path, name: path.basename(row.path) })),
    ),
  );
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--sqlite-measurement-channel=${channel}`],
      partition: `measurement-${randomUUID()}`,
    },
  });
  const allowed = new Set([pathToFileURL(page).href, pathToFileURL(script).href]);
  win.webContents.session.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !allowed.has(details.url) }),
  );
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  let resolveDelivery;
  let rejectDelivery;
  const delivered = () =>
    new Promise((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });
  let pending = delivered();
  const onMessage = (event, value) => {
    if (
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame ||
      event.senderFrame.url !== pathToFileURL(page).href
    )
      return;
    try {
      if (value === "ready")
        registry.subscribe(
          { id: "measurement", view: "repositories", params: { limit: 100 } },
          (snapshot) => win.webContents.send(channel, snapshot),
        );
      else {
        if (
          !value ||
          !Number.isSafeInteger(value.generation) ||
          !Number.isSafeInteger(value.revision) ||
          typeof value.first !== "string"
        )
          throw Error("Invalid fixture acknowledgement");
        registry.acknowledge("measurement", value.generation, value.revision);
        resolveDelivery({ time: performance.timeOrigin + performance.now(), first: value.first });
      }
    } catch (error) {
      rejectDelivery(error);
    }
  };
  ipcMain.on(channel, onMessage);
  try {
    await win.loadFile(page);
    const first = await pending;
    pending = delivered();
    const writeStart = performance.timeOrigin + performance.now();
    await executeDataCommand(db, {
      type: "register-repository",
      path: path.join(root, "0000-written"),
    });
    const next = await pending;
    if (next.first !== "0000-written") throw Error("Renderer did not receive committed data");
    return { firstViewAt: first.time, writeToViewMs: next.time - writeStart };
  } finally {
    ipcMain.removeListener(channel, onMessage);
    registry.dispose();
    win.destroy();
    await db.close();
  }
}
measure().then(
  (result) => {
    console.log(`SQLITE_MEASUREMENT ${JSON.stringify(result)}`);
    app.quit();
  },
  () => {
    console.error("SQLite measurement fixture failed");
    app.exit(1);
  },
);
