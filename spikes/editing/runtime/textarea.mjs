const input = document.createElement('textarea');
input.setAttribute('aria-label', 'Scratch pad');
input.spellcheck = false;
document.querySelector('#editor').append(input);
window.spikeEditor = { get: () => input.value, set: text => { input.value = text; }, focus: () => input.focus() };
