import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import squirrelStartup from 'electron-squirrel-startup'
import { updateElectronApp, UpdateSourceType } from 'update-electron-app'
import { BackendHost } from './backend-host'
import { loadOrCreateMasterKey } from './key-provider'

// Windows のインストーラー（Squirrel）がショートカット作成などのために起動したときは、すぐ終了する
if (squirrelStartup) app.quit()

// 配布版の自動アップデート（GitHub Releases → update.electronjs.org）。
// macOS は署名済みビルドのみ、Linux は対象外。開発中・E2E テストでは動かさない。
if (
  app.isPackaged &&
  process.platform !== 'linux' &&
  process.env.MM_DISABLE_AUTO_UPDATE !== '1' &&
  !process.env.MM_USER_DATA
) {
  updateElectronApp({
    updateSource: { type: UpdateSourceType.ElectronPublicUpdateService, repo: 'ANFINII/mail-manager' },
    updateInterval: '1 hour',
    notifyUser: true,
  })
}

// テスト・開発用: userData の場所を差し替える
if (process.env.MM_USER_DATA) app.setPath('userData', process.env.MM_USER_DATA)

let host: BackendHost | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'Mail Manager',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
  } else {
    void win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`))
  }
  if (process.env.MM_OPEN_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' })
  // メール本文など外部コンテンツから window.open されても新しい Electron ウィンドウを作らない
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return win
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  let masterKey
  try {
    masterKey = await loadOrCreateMasterKey(userData, {
      allowInsecure: process.env.MM_INSECURE_KEY_FILE === '1',
    })
  } catch (err) {
    dialog.showErrorBox('暗号鍵を用意できません', err instanceof Error ? err.message : String(err))
    app.quit()
    return
  }

  host = new BackendHost({
    scriptPath: path.join(__dirname, 'backend.js'),
    userDataPath: userData,
    masterKey: masterKey.key,
    keyMode: masterKey.mode,
    version: app.getVersion(),
    env: process.env,
  })
  host.onEvent((event) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('backend-event', event)
    if (event.type === 'messages.new') notifyNewMail(event.notice)
  })
  host.start()

  ipcMain.handle('rpc', (_event, method: unknown, params: unknown) => {
    if (typeof method !== 'string') throw new Error('Invalid RPC method')
    return host!.call(method, params)
  })
  ipcMain.handle('dialog.openCsv', async () => {
    const r = await dialog.showOpenDialog({
      title: 'アカウント CSV を選択',
      properties: ['openFile'],
      filters: [
        { name: 'CSV / テキスト', extensions: ['csv', 'txt', 'tsv'] },
        { name: 'すべてのファイル', extensions: ['*'] },
      ],
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })
  ipcMain.handle('shell.showItemInFolder', (_event, p: unknown) => {
    if (typeof p === 'string') shell.showItemInFolder(p)
  })
  ipcMain.handle('shell.openPath', async (_event, p: unknown) => {
    if (typeof p === 'string') await shell.openPath(p)
  })
  // OAuth のサインイン画面を既定のブラウザで開く。任意の URL を開けないよう https に限る
  ipcMain.handle('shell.openExternal', async (_event, url: unknown) => {
    if (typeof url !== 'string') return
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol === 'https:' || (!app.isPackaged && parsed.protocol === 'http:'))
      await shell.openExternal(parsed.toString())
  })
  ipcMain.handle(
    'dialog.openFile',
    async (_event, opts: { title?: string; extensions?: string[] }) => {
      const r = await dialog.showOpenDialog({
        title: opts?.title,
        properties: ['openFile'],
        filters: opts?.extensions?.length
          ? [{ name: opts.extensions.join(', '), extensions: opts.extensions }]
          : undefined,
      })
      return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
    },
  )
  ipcMain.handle(
    'dialog.saveFile',
    async (_event, opts: { title?: string; defaultName?: string; extensions?: string[] }) => {
      const r = await dialog.showSaveDialog({
        title: opts?.title,
        defaultPath: opts?.defaultName
          ? path.join(app.getPath('downloads'), opts.defaultName)
          : undefined,
        filters: opts?.extensions?.length
          ? [{ name: opts.extensions.join(', '), extensions: opts.extensions }]
          : undefined,
      })
      return r.canceled || !r.filePath ? null : r.filePath
    },
  )

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 同期中にアカウントごとの通知が数百件出ないよう、3 秒間の新着をまとめて 1 通知にする
const newMailBuffer = {
  count: 0,
  accounts: new Map<
    string,
    { count: number; latestSubject: string | null; latestFrom: string | null }
  >(),
  timer: null as ReturnType<typeof setTimeout> | null,
}

function notifyNewMail(notice: {
  email: string;
  count: number;
  latestSubject: string | null;
  latestFrom: string | null;
}): void {
  newMailBuffer.count += notice.count
  const prev = newMailBuffer.accounts.get(notice.email)
  newMailBuffer.accounts.set(notice.email, {
    count: (prev?.count ?? 0) + notice.count,
    latestSubject: notice.latestSubject ?? prev?.latestSubject ?? null,
    latestFrom: notice.latestFrom ?? prev?.latestFrom ?? null,
  })
  if (newMailBuffer.timer) return
  newMailBuffer.timer = setTimeout(() => void flushNewMailNotification(), 3000)
}

async function flushNewMailNotification(): Promise<void> {
  const total = newMailBuffer.count
  const accounts = [...newMailBuffer.accounts.entries()]
  newMailBuffer.count = 0
  newMailBuffer.accounts.clear()
  newMailBuffer.timer = null
  if (total === 0) return
  try {
    const settings = (await host?.call('settings.get', {})) as
      { notifyNewMail?: boolean } | undefined
    if (!settings?.notifyNewMail || !Notification.isSupported()) return
    let title: string
    let body: string
    if (accounts.length === 1) {
      const [email, info] = accounts[0]
      title = `${email}: 新着 ${info.count} 件`
      body = info.latestSubject
        ? `${info.latestSubject}${info.latestFrom ? ` — ${info.latestFrom}` : ''}`
        : ''
    } else {
      title = `新着メール ${total} 件`
      body = `${accounts.length} アカウント: ${accounts
        .slice(0, 3)
        .map(([email, info]) => `${email} (${info.count})`)
        .join(', ')}${accounts.length > 3 ? ' …' : ''}`
    }
    const n = new Notification({ title, body, silent: true })
    n.on('click', () => {
      const w = BrowserWindow.getAllWindows()[0]
      if (w) {
        if (w.isMinimized()) w.restore()
        w.focus()
      }
    })
    n.show()
  } catch {
    // 通知の失敗は無視
  }
}

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  host?.stop()
})
