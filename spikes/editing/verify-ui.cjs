const {_electron:electron}=require('@playwright/test');
const {expect,deadline}=require('../../tests/electron/test-policy.js');
const {default:axe}=require('@axe-core/playwright');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
if(process.platform==='linux'&&!process.env.DISPLAY)throw Error('xvfb-run -a required');
(async()=>{const results=[];for(const [kind,workers]of [['textarea','foom'],['codemirror','foom'],['monaco','foom'],['monaco','blocked']]){const profile=fs.mkdtempSync(path.join(os.tmpdir(),'editing-ui-'));let app;try{
 app=await electron.launch({args:[path.join(__dirname,'main.cjs')],env:{...process.env,EDITING_PROFILE:profile,EDITING_KIND:kind,EDITING_WORKERS:workers},timeout:deadline(20000)});
 const page=await app.firstWindow();const errors=[];page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>window.ready,{},{timeout:deadline(10000)});
 await page.evaluate(()=>{window.spikeEditor.set('const answer = 42;\n// draft 💫');window.spikeEditor.focus();});
 await page.keyboard.press('End');await page.keyboard.type(' edited');await page.getByRole('button',{name:'Save draft'}).click();await expect(page.getByRole('status')).toHaveText('Saved');const draft=await page.evaluate(()=>window.spikeEditor.get());
 await page.reload();await page.waitForFunction(()=>window.ready);expect(await page.evaluate(()=>window.spikeEditor.get())).toBe(draft);
 await page.evaluate(()=>window.spikeEditor.focus());await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({type:'keyDown',keyCode:'B',modifiers:['control','shift']}));await expect(page.getByRole('button',{name:'Sidebar'})).toBeFocused();
 await page.evaluate(()=>window.spikeEditor.focus());await page.keyboard.press('Tab');const tabFocus=await page.evaluate(()=>document.activeElement?.id||document.activeElement?.className);
 const report=await new axe({page}).setLegacyMode().analyze();const severe=report.violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>v.id);
 const boundary=await page.evaluate(()=>({require:typeof window.require,process:typeof window.process,desktop:typeof window.desktop}));
 const rejected=await page.evaluate(async()=>{const cases=[];for(const [id,text]of [['../file','bad'],['pad-0','a'.repeat(65537)]]){try{await window.scratch.save(id,text);cases.push(false);}catch{cases.push(true);}}return cases;});expect(rejected).toEqual([true,true]);
 // A CSP-blocked worker throws or fires a securitypolicyviolation; an allowed one starts and waits for Monaco's init message.
 let worker; if(kind==='monaco')worker=await page.evaluate(async()=>{try{const w=new Worker('./editor.worker.js',{type:'module'});return await new Promise(resolve=>{w.onerror=()=>{w.terminate();resolve('error');};setTimeout(()=>{w.terminate();resolve((window.violations||[]).includes('worker-src')?'blocked':'started');},500);});}catch(e){return e.name;}});
 results.push({kind,workers,persisted:true,shortcut:'Sidebar focused',tabFocus,severeAxe:severe,boundary,rejected,worker,violations:await page.evaluate(()=>window.violations||[]),errors});
 console.log(JSON.stringify({kind,severe,nodes:report.violations.flatMap(v=>v.nodes.map(n=>({id:v.id,html:n.html,summary:n.failureSummary})))},null,2));if(workers==='foom'){await page.screenshot({path:path.join(__dirname,`results/${kind}.png`)});}
 }finally{if(app)await app.close();fs.rmSync(profile,{recursive:true,force:true});}}
 fs.writeFileSync(path.join(__dirname,'results/ui.json'),JSON.stringify({platform:process.platform,electron:require('electron/package.json').version,runs:results},null,2)+'\n');console.log(JSON.stringify(results,null,2));})().catch(e=>{console.error(e);process.exitCode=1;});
