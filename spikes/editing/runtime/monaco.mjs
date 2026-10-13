import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/languages/definitions/javascript/register.js';
window.MonacoEnvironment = { getWorker: () => new Worker('./editor.worker.js', {type:'module'}) };
monaco.editor.defineTheme('foom-spike', {base:'vs-dark',inherit:true,rules:[],colors:{'editor.background':'#05040A','editor.foreground':'#F4EFFF','editor.selectionBackground':'#251D3F'}});
const view = monaco.editor.create(document.querySelector('#editor'), {language:'javascript',theme:'foom-spike',ariaLabel:'Scratch pad',automaticLayout:true,minimap:{enabled:false}});
window.spikeEditor = {get:()=>view.getValue(),set:text=>view.setValue(text),focus:()=>view.focus()};
