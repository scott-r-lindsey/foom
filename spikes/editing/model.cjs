// Evidence prototype, deliberately not a production filesystem capability.
const fs = require('node:fs');
const path = require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const hash=b=>createHash('sha256').update(b).digest('hex');
function relativeName(value) {
 if(typeof value!=='string'||value.length>1024||value.split('/').some(s=>!s||s==='.'||s==='..'||s.startsWith('.')||/[\\:\x00-\x1f<>"|?*]/.test(s)||/[. ]$/.test(s)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) throw Error('path');
 return value;
}
function target(root,name) {
 relativeName(name); const canonical=fs.realpathSync(root); const file=path.join(canonical,name);
 // Refuse all symlinks, including parent links; simpler for a writable surface.
 let p=canonical;for(const part of name.split('/')) {p=path.join(p,part);if(fs.lstatSync(p).isSymbolicLink())throw Error('symlink');}
 const real=fs.realpathSync(file);if(!real.startsWith(canonical+path.sep))throw Error('escape');return real;
}
function read(root,name) {
 const file=target(root,name);const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try {const s=fs.fstatSync(fd);if(!s.isFile())throw Error('regular');if(s.size>1024*1024)throw Error('size');const bytes=fs.readFileSync(fd);if(bytes.length>1024*1024)throw Error('size');
 if(bytes.includes(0))throw Error('binary');let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw Error('encoding');}
 return {file,bytes,text,hash:hash(bytes),mode:s.mode&0o777};}finally{fs.closeSync(fd);}
}
function save(root,name,base,text,afterCheck=()=>{}) {
 const current=read(root,name);if(current.hash!==base)return {status:'conflict',disk:current.text,draft:text};
 const bytes=Buffer.from(text);if(bytes.length>1024*1024)throw Error('size');
 const temp=path.join(path.dirname(current.file),`.editing-${randomUUID()}`);
 try{fs.writeFileSync(temp,bytes,{flag:'wx',mode:current.mode});const fd=fs.openSync(temp,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 if(read(root,name).hash!==base)return {status:'conflict',draft:text};
 afterCheck(); // Fault injection: external write in the unavoidable check/rename gap.
 fs.renameSync(temp,current.file);return {status:'saved',hash:hash(bytes)};
 }finally{fs.rmSync(temp,{force:true});}
}
class ScratchStore {
 constructor(profile){this.dir=path.join(profile,'scratch');fs.mkdirSync(this.dir,{recursive:true,mode:0o700});if(fs.lstatSync(this.dir).isSymbolicLink())throw Error('symlink');}
 file(id){if(typeof id!=='string'||!/^pad-[0-9]{1,2}$/.test(id)||Number(id.slice(4))>=16)throw Error('id');return path.join(this.dir,id+'.txt');}
 write(id,text){const file=this.file(id);if(typeof text!=='string'||Buffer.byteLength(text)>65536)throw Error('size');let stat;try{stat=fs.lstatSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}if(stat?.isSymbolicLink())throw Error('symlink');const temp=file+'.tmp-'+randomUUID();try{fs.writeFileSync(temp,text,{flag:'wx',mode:0o600});fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}}
 read(id){const file=this.file(id);try{const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const s=fs.fstatSync(fd);if(!s.isFile()||s.size>65536)throw Error('size');const b=fs.readFileSync(fd);if(b.length>65536)throw Error('size');return new TextDecoder('utf-8',{fatal:true}).decode(b);}finally{fs.closeSync(fd);}}catch(e){if(e.code==='ENOENT')return '';throw e;}}
}
function launchPlan(kind,executable,file,line=1,column=1) {
 if(!path.isAbsolute(executable)||!path.isAbsolute(file)||/[\x00-\x1f]/.test(file)||!Number.isSafeInteger(line)||line<1||line>1e7||!Number.isSafeInteger(column)||column<1||column>1e7)throw Error('launch');
 const args=kind==='code'||kind==='cursor'?['--goto',`${file}:${line}:${column}`]:kind==='zed'||kind==='subl'?[`${file}:${line}:${column}`]:kind==='idea'?['--line',String(line),'--column',String(column),file]:kind==='vim'||kind==='nvim'?['--clean',`+${line}`,'--',file]:undefined;
 if(!args)throw Error('editor');return {executable,args,terminal:kind==='vim'||kind==='nvim'};
}
module.exports={read,save,hash,relativeName,ScratchStore,launchPlan};
