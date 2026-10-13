import { build } from '../../node_modules/esbuild/lib/main.js';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
const out = new URL('./build/',import.meta.url);
await mkdir(out,{recursive:true});
const rows=[];
for(const name of ['textarea','codemirror','monaco']) {
 const dir=new URL(`${name}/`,out); await mkdir(dir,{recursive:true});
 await build({entryPoints:[new URL(`./runtime/${name}.mjs`,import.meta.url).pathname],outfile:new URL('editor.js',dir).pathname,bundle:true,minify:true,format:'esm',platform:'browser',loader:{'.ttf':'file'},define:{'process.env.NODE_ENV':'"production"'}});
 if(name==='monaco') await build({entryPoints:[new URL('./node_modules/monaco-editor/esm/vs/editor/editor.worker.js',import.meta.url).pathname],outfile:new URL('editor.worker.js',dir).pathname,bundle:true,minify:true,format:'esm',platform:'browser'});
 const files=[]; for(const file of await readdir(dir)) {const b=await readFile(new URL(file,dir)); files.push({file,bytes:b.length,gzip:gzipSync(b).length});}
 rows.push({name,files,bytes:files.reduce((n,f)=>n+f.bytes,0),gzip:files.reduce((n,f)=>n+f.gzip,0)});
}
await writeFile(new URL('./results/bundles.json',import.meta.url),JSON.stringify({node:process.version,esbuild:'0.28.2',rows},null,2)+'\n');
console.log(JSON.stringify(rows,null,2));
