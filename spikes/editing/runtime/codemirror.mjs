import { EditorView, basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
// Foom tokens only: amber and magenta are reserved for status, so syntax uses accent, ink, muted and type style.
const foomHighlight = HighlightStyle.define([
 { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--accent)' },
 { tag: [tags.string, tags.number, tags.bool, tags.null], color: 'var(--ink)', fontStyle: 'italic' },
 { tag: [tags.comment], color: 'var(--muted)', fontStyle: 'italic' },
 { tag: [tags.definition(tags.variableName), tags.function(tags.variableName)], color: 'var(--ink)', fontWeight: '600' },
]);
const view = new EditorView({ parent: document.querySelector('#editor'), extensions: [basicSetup, javascript(), syntaxHighlighting(foomHighlight), EditorView.contentAttributes.of({'aria-label':'Scratch pad'}), EditorView.theme({ '&': {color:'var(--ink)',backgroundColor:'var(--bg)'}, '.cm-content':{caretColor:'var(--ink)'}, '.cm-gutters':{backgroundColor:'var(--surface)',color:'var(--muted)',borderColor:'var(--line)'}, '.cm-activeLine':{backgroundColor:'var(--surface)'}, '.cm-activeLineGutter':{backgroundColor:'var(--line)'}, '&.cm-focused .cm-selectionBackground, .cm-selectionBackground':{backgroundColor:'var(--line)'}, '.cm-cursor':{borderLeftColor:'var(--ink)'} }, {dark:true})] });
window.spikeEditor = { get: () => view.state.doc.toString(), set: text => view.dispatch({changes:{from:0,to:view.state.doc.length,insert:text}}), focus:()=>view.focus() };
