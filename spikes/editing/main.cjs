const {app,BrowserWindow,protocol,session,ipcMain}=require('electron');
const fs=require('node:fs');const path=require('node:path');const {ScratchStore}=require('./model.cjs');
if(process.platform==='linux'&&!process.env.DISPLAY)throw Error('Run under xvfb-run -a');
if(!process.env.EDITING_PROFILE)throw Error('Disposable EDITING_PROFILE required');
app.setPath('userData',process.env.EDITING_PROFILE);app.enableSandbox();
protocol.registerSchemesAsPrivileged([{scheme:'editing',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const kind=process.env.EDITING_KIND||'textarea';if(!['textarea','codemirror','monaco'].includes(kind))throw Error('kind');
const url='editing://bundle/index.html';let win;
app.whenReady().then(async()=>{
 const store=new ScratchStore(app.getPath('userData'));
 session.defaultSession.setPermissionRequestHandler((_,__,callback)=>callback(false));session.defaultSession.setPermissionCheckHandler(()=>false);
 session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('editing://bundle/')}));
 const csp="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"+(process.env.EDITING_WORKERS==='blocked'?"; worker-src 'none'":'');
 // 'foom' is Foom's exact renderer CSP: worker-src falls back to script-src 'self'.
 protocol.handle('editing',request=>{
  const pathname=new URL(request.url).pathname;
  if(pathname==='/index.html')return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Editing spike</title><link rel="stylesheet" href="common.css">${kind==='monaco'?'<link rel="stylesheet" href="editor.css">':''}</head><body><h1>Scratch pad</h1><p>Profile-owned text · no worktree file</p><main id="editor"></main><button id="save">Save draft</button><button id="sidebar">Sidebar</button><p id="status" role="status">Ready</p><script type="module" src="editor.js"></script><script type="module" src="scratch.js"></script></body></html>`,{headers:{'content-type':'text/html','content-security-policy':csp}});
  const assets={'/editor.js':path.join(__dirname,'build',kind,'editor.js'),'/editor.css':path.join(__dirname,'build',kind,'editor.css'),'/editor.worker.js':path.join(__dirname,'build',kind,'editor.worker.js'),'/common.css':path.join(__dirname,'runtime/common.css'),'/scratch.js':path.join(__dirname,'runtime/scratch.mjs')};
  const file=assets[pathname];if(!file||!fs.existsSync(file))return new Response('',{status:404});return new Response(fs.readFileSync(file),{headers:{'content-type':pathname.endsWith('.css')?'text/css':'text/javascript'}});
 });
 win=new BrowserWindow({width:900,height:650,webPreferences:{preload:path.join(__dirname,'runtime/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());
 win.webContents.on('before-input-event',(event,input)=>{if(input.type==='keyDown'&&input.control&&input.shift&&input.key.toLowerCase()==='b'){event.preventDefault();win.webContents.executeJavaScript("document.querySelector('#sidebar').focus()");}});
 function sender(event){if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||event.senderFrame.url!==url)throw Error('sender');}
 ipcMain.handle('scratch:read',(event,...args)=>{sender(event);if(args.length!==1)throw Error('args');return store.read(args[0]);});
 ipcMain.handle('scratch:save',(event,...args)=>{sender(event);if(args.length!==2)throw Error('args');store.write(args[0],args[1]);return true;});
 await win.loadURL(url);
});
app.on('window-all-closed',()=>app.quit());
