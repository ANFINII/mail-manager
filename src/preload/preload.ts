import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { BackendEvent, RendererApi } from '@shared/api'

const api: RendererApi = {
  call: (method, params) => ipcRenderer.invoke('rpc', method, params),
  onEvent: (listener) => {
    const wrapped = (_e: IpcRendererEvent, event: BackendEvent) => listener(event)
    ipcRenderer.on('backend-event', wrapped)
    return () => ipcRenderer.removeListener('backend-event', wrapped)
  },
  openCsvDialog: () => ipcRenderer.invoke('dialog.openCsv'),
  openFileDialog: (opts) => ipcRenderer.invoke('dialog.openFile', opts),
  saveFileDialog: (opts) => ipcRenderer.invoke('dialog.saveFile', opts),
  showItemInFolder: (p) => ipcRenderer.invoke('shell.showItemInFolder', p),
  openPath: (p) => ipcRenderer.invoke('shell.openPath', p),
  openExternal: (url) => ipcRenderer.invoke('shell.openExternal', url),
}

contextBridge.exposeInMainWorld('api', api)
