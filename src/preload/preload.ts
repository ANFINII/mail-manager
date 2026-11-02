import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { BackendEvent, RendererApi } from '@shared/api'
import type { LockStatus } from '@shared/types'

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
  remote: {
    get: () => ipcRenderer.invoke('remote.get'),
    test: (url, token) => ipcRenderer.invoke('remote.test', url, token),
    set: (next) => ipcRenderer.invoke('remote.set', next),
  },
  lock: {
    status: () => ipcRenderer.invoke('lock.status'),
    lockNow: () => ipcRenderer.invoke('lock.lockNow'),
    unlock: (passcode) => ipcRenderer.invoke('lock.unlock', passcode),
    touchId: () => ipcRenderer.invoke('lock.touchId'),
    setPasscode: (current, next) => ipcRenderer.invoke('lock.setPasscode', current, next),
    configure: (opts) => ipcRenderer.invoke('lock.configure', opts),
    onChange: (listener) => {
      const wrapped = (_e: IpcRendererEvent, status: LockStatus) => listener(status)
      ipcRenderer.on('lock-changed', wrapped)
      return () => ipcRenderer.removeListener('lock-changed', wrapped)
    },
  },
}

contextBridge.exposeInMainWorld('api', api)
