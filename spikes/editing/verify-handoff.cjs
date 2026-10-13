const {_electron:electron}=require('@playwright/test');
const {expect,deadline}=require('../../tests/electron/test-policy.js');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const pty=require('node-pty');
const {gitSync}=require('../../tests/helpers/git.js');const {launchPlan}=require('./model.cjs');
if(process.platform!=='linux'||!process.env.DISPLAY)throw Error('Linux, xvfb-run -a only');
(async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'editing-handoff-'));let app;let terminal;let terminalExited;
try{const repo=path.join(root,'repo');fs.mkdirSync(repo);gitSync(['init','--quiet'],{cwd:repo});const file=path.join(repo,'- spaced $(literal).txt');fs.writeFileSync(file,Array.from({length:80},(_,i)=>`line ${i+1}`).join('\n'));
const profile=path.join(root,'profile');fs.mkdirSync(path.join(profile,'User'),{recursive:true});fs.writeFileSync(path.join(profile,'User/settings.json'),JSON.stringify({'telemetry.telemetryLevel':'off','update.mode':'none','extensions.autoCheckUpdates':false,'extensions.autoUpdate':false,'workbench.startupEditor':'none','security.workspace.trust.enabled':true}));
const plan=launchPlan('code','/usr/bin/code',file,42,3);
app=await electron.launch({executablePath:'/usr/share/code/code',args:['--user-data-dir',profile,'--extensions-dir',path.join(root,'extensions'),'--disable-extensions','--new-window',...plan.args],timeout:deadline(20000)});
const page=await app.firstWindow();await expect(page.locator('.tab').filter({hasText:'- spaced $(literal).txt'})).toBeVisible();await expect(page.locator('#status\\.editor\\.selection')).toContainText('Ln 42, Col 3');
const selection=await page.locator('#status\\.editor\\.selection').innerText();const title=await page.title();await app.close();app=null;
// A terminal editor launch through a real PTY, using only disposable state.
const nvimPlan=launchPlan('nvim','/usr/bin/nvim',file,42,3);let output='';terminal=pty.spawn(nvimPlan.executable,['-u','NONE','-i','NONE',...nvimPlan.args],{name:'xterm-256color',cols:90,rows:30,cwd:repo,env:{...process.env,XDG_CONFIG_HOME:path.join(root,'config'),XDG_DATA_HOME:path.join(root,'data'),XDG_STATE_HOME:path.join(root,'state'),XDG_CACHE_HOME:path.join(root,'cache')}});
terminalExited=new Promise(resolve=>terminal.onExit(resolve));await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('PTY visible deadline')),deadline(10000));terminal.onData(data=>{output+=data;if(output.includes('line 42')){clearTimeout(timer);resolve();}});});terminal.write(':q!\r');const exit=await terminalExited;terminal=null;expect(exit.exitCode).toBe(0);
const data={platform:'linux',codeVersion:require('node:child_process').execFileSync('/usr/bin/code',['--version'],{encoding:'utf8'}).split('\n')[0],gui:{literalFilename:true,title,selection,isolatedProfile:true,sandboxDisabled:false},terminal:{editor:'nvim',visibleLine42:true,exitCode:exit.exitCode,isolatedConfig:true},worktreeContentUnchanged:fs.readFileSync(file,'utf8').startsWith('line 1\n')};fs.writeFileSync(path.join(__dirname,'results/handoff.json'),JSON.stringify(data,null,2)+'\n');console.log(JSON.stringify(data,null,2));
}finally{if(app)await app.close();if(terminal){terminal.kill();await terminalExited;}fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
