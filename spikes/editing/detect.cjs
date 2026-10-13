const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {execFileSync}=require('node:child_process');
function find(name){for(const dir of (process.env.PATH||'').split(path.delimiter)){if(!path.isAbsolute(dir))continue;const candidate=path.join(dir,name);try{fs.accessSync(candidate,fs.constants.X_OK);if(fs.statSync(candidate).isFile())return candidate;}catch{}}return null;}
function probe(executable,args){try{return {ok:true,output:execFileSync(executable,args,{timeout:5000,encoding:'utf8',maxBuffer:65536}).trim().split('\n')[0]};}catch(e){return {ok:false,code:e.code||e.status};}}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'editing-detect-'));
try{const rows=[];for(const name of ['code','cursor','zed','zeditor','idea','idea.sh','subl','nvim','vim','nano','flatpak','snap']){const executable=find(name);rows.push({name,executable,real:executable?fs.realpathSync(executable):null,version:executable?probe(executable,['--version']):null});}
 const flatpak=find('flatpak');// Record only known editor IDs, never the rest of the user's installed applications.
 const editorIds=['com.visualstudio.code','com.vscodium.codium','dev.zed.Zed','com.sublimetext.three','com.jetbrains.IntelliJ-IDEA-Community','com.jetbrains.IntelliJ-IDEA-Ultimate'];
 const listed=flatpak?probe(flatpak,['list','--app','--columns=application']):null;const packages=listed&&{ok:listed.ok,checked:editorIds,installed:listed.ok?editorIds.filter(id=>execFileSync(flatpak,['list','--app','--columns=application'],{encoding:'utf8'}).split('\n').includes(id)):[]};
 const fixture=path.join(root,'fixture.txt');fs.writeFileSync(fixture,Array.from({length:80},(_,i)=>`line ${i+1}`).join('\n'));
 const terminal=[];for(const kind of ['nvim','vim']){const executable=find(kind);if(!executable)continue;const result=path.join(root,kind+'.txt');const args=kind==='nvim'?['--headless','-u','NONE','-i','NONE',fixture,'+42',`+call writefile([string(line('.'))], '${result}')`,'+q']:['-es','-u','NONE','-i','NONE',fixture,'+42',`+call writefile([string(line('.'))], '${result}')`,'+q'];const run=probe(executable,args);terminal.push({kind,ok:run.ok,line:fs.existsSync(result)?fs.readFileSync(result,'utf8').trim():null});}
 const data={platform:process.platform,rows,flatpakApplications:packages,terminal,environmentSelection:{visualSet:!!process.env.VISUAL,editorSet:!!process.env.EDITOR}};
 fs.writeFileSync(path.join(__dirname,'results/detection.json'),JSON.stringify(data,null,2)+'\n');console.log(JSON.stringify(data,null,2));
}finally{fs.rmSync(root,{recursive:true,force:true});}
