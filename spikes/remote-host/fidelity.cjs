// Run only under xvfb-run on Linux. Loads the browser xterm with no Node bridge.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const root = path.resolve(__dirname, "../..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "foom-fidelity-"));
app.setPath("userData", path.join(scratch, "profile"));
app.enableSandbox();
let win;
const deadline = setTimeout(() => {
  console.error("fidelity timeout");
  app.exit(1);
}, 30000);
app.whenReady().then(async () => {
  try {
    const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    fs.copyFileSync(
      path.join(root, "node_modules/@xterm/xterm/lib/xterm.js"),
      path.join(scratch, "xterm.js"),
    );
    fs.writeFileSync(
      path.join(scratch, "index.html"),
      `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'"><div id="terminal"></div><script src="xterm.js"></script>`,
    );
    win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
    });
    await win.loadFile(path.join(scratch, "index.html"));
    const actual = await win.webContents.executeJavaScript(
      `(async()=>{const t=new Terminal({cols:80,rows:24,allowProposedApi:true});t.open(document.getElementById('terminal'));await new Promise(r=>t.write(${JSON.stringify(data.snapshot)},r));const b=t.buffer.active;return {cursor:[b.cursorX,b.cursorY],type:b.type,rows:Array.from({length:t.rows},(_,y)=>Array.from({length:t.cols},(_,x)=>{const c=b.getLine(b.baseY+y).getCell(x);return [c.getChars(),c.getWidth(),c.getFgColorMode(),c.getFgColor(),c.getBgColorMode(),c.getBgColor(),c.isBold(),c.isItalic(),c.isUnderline()];}))};})()`,
    );
    if (JSON.stringify(actual) !== JSON.stringify(data.expected))
      throw Error("browser/headless cells differ");
    console.log(
      JSON.stringify({
        browserXtermCellsEqual: true,
        electron: process.versions.electron,
        cols: 80,
        rows: 24,
      }),
    );
    win.destroy();
    win = null;
    clearTimeout(deadline);
    app.quit();
  } catch (e) {
    console.error(e);
    if (win) win.destroy();
    clearTimeout(deadline);
    app.exit(1);
  }
});
app.on("quit", () => fs.rmSync(scratch, { recursive: true, force: true }));
