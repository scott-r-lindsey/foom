window.spikeEditor.set(await window.scratch.read('pad-0'));
document.querySelector('#save').addEventListener('click',async()=>{await window.scratch.save('pad-0',window.spikeEditor.get());document.querySelector('#status').textContent='Saved';});
document.addEventListener('securitypolicyviolation',event=>{(window.violations??=[]).push(event.violatedDirective);});
window.ready=true;
