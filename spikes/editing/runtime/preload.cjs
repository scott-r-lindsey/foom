const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('scratch',{read:id=>ipcRenderer.invoke('scratch:read',id),save:(id,text)=>ipcRenderer.invoke('scratch:save',id,text)});
