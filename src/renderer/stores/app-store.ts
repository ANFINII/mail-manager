import { create } from 'zustand'
import type { BackendEvent } from '@shared/api'
import type {
  AccountGroupInfo,
  AccountSummary,
  AppInfo,
  AutoSyncState,
  DashboardStats,
  JobInfo,
  Settings,
  SyncProgress,
} from '@shared/types'
import { api, errorMessage } from 'lib/api'
import i18next from '../i18n'

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  message: string;
}

export interface AppState {
  accounts: AccountSummary[];
  /** アカウントグループ（名前順） */
  groups: AccountGroupInfo[];
  stats: DashboardStats | null;
  jobs: JobInfo[];
  settings: Settings | null;
  info: AppInfo | null;
  /** 自動同期ボタンの状態（起動時は OFF） */
  autoSync: AutoSyncState | null;
  toasts: Toast[];
  loaded: boolean;
  /** アカウント ID → 直近の同期進捗 */
  syncProgress: Record<string, SyncProgress>;
  /** メールの追加・変更・削除があるたびに増える（検索画面の再読み込み用） */
  messagesChangedTick: number;
  mailboxesTick: number;
  loadAll(): Promise<void>;
  refreshAccounts(): Promise<void>;
  refreshGroups(): Promise<void>;
  refreshStats(): Promise<void>;
  refreshJobs(): Promise<void>;
  refreshSettings(): Promise<void>;
  setAutoSync(enabled: boolean): Promise<void>;
  applyEvent(event: BackendEvent): void;
  notify(kind: Toast['kind'], message: string): void;
  dismissToast(id: number): void;
}

let toastSeq = 0
// 300 アカウントの同期で 1 アカウントずつトーストを出さないよう、新着通知は 1.5 秒ごとにまとめる
const newMailBuffer = {
  count: 0,
  accounts: new Map<string, number>(),
  timer: null as ReturnType<typeof setTimeout> | null,
}
const MAX_TOASTS = 5

export const useAppStore = create<AppState>((set, get) => ({
  accounts: [],
  groups: [],
  stats: null,
  jobs: [],
  settings: null,
  info: null,
  autoSync: null,
  toasts: [],
  loaded: false,
  syncProgress: {},
  messagesChangedTick: 0,
  mailboxesTick: 0,

  async loadAll() {
    try {
      const [accounts, groups, stats, jobs, settings, info, autoSync] = await Promise.all([
        api.call('accounts.list', {}),
        api.call('groups.list', {}),
        api.call('stats.get', {}),
        api.call('jobs.list', {}),
        api.call('settings.get', {}),
        api.call('app.info', {}),
        api.call('autoSync.get', {}),
      ])
      set({ accounts, groups, stats, jobs, settings, info, autoSync, loaded: true })
    } catch (err) {
      get().notify('error', errorMessage(err))
    }
  },

  async refreshAccounts() {
    set({ accounts: await api.call('accounts.list', {}) })
  },
  async refreshGroups() {
    set({ groups: await api.call('groups.list', {}) })
  },
  async refreshStats() {
    set({ stats: await api.call('stats.get', {}) })
  },
  async refreshJobs() {
    set({ jobs: await api.call('jobs.list', {}) })
  },
  async refreshSettings() {
    set({ settings: await api.call('settings.get', {}) })
  },
  async setAutoSync(enabled) {
    try {
      const state = await api.call('autoSync.set', { enabled })
      set({ autoSync: state })
      get().notify(
        'info',
        state.enabled
          ? state.intervalSec > 0
            ? i18next.t('autoSync.turnedOnInterval', { seconds: state.intervalSec })
            : i18next.t('autoSync.turnedOn')
          : i18next.t('autoSync.turnedOff'),
      )
    } catch (err) {
      get().notify('error', errorMessage(err))
    }
  },

  applyEvent(event) {
    switch (event.type) {
      case 'accounts.updated': {
        const byId = new Map(event.accounts.map((a) => [a.id, a]))
        set((s) => ({ accounts: s.accounts.map((a) => byId.get(a.id) ?? a) }))
        return
      }
      case 'accounts.removed': {
        const ids = new Set(event.ids)
        set((s) => ({ accounts: s.accounts.filter((a) => !ids.has(a.id)) }))
        void get().refreshGroups()
        return
      }
      case 'accounts.imported':
        void get().refreshAccounts()
        return
      case 'groups.changed':
        set({ groups: event.groups })
        return
      case 'job.updated':
        set((s) => {
          const others = s.jobs.filter((j) => j.id !== event.job.id)
          return {
            jobs: [event.job, ...others]
              .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
              .slice(0, 20),
          }
        })
        return
      case 'stats.updated':
        set({ stats: event.stats })
        return
      case 'sync.progress':
        set((s) => ({
          syncProgress: { ...s.syncProgress, [event.progress.accountId]: event.progress },
        }))
        return
      case 'messages.new': {
        set((s) => ({ messagesChangedTick: s.messagesChangedTick + 1 }))
        newMailBuffer.count += event.notice.count
        newMailBuffer.accounts.set(
          event.notice.email,
          (newMailBuffer.accounts.get(event.notice.email) ?? 0) + event.notice.count,
        )
        if (!newMailBuffer.timer) {
          newMailBuffer.timer = setTimeout(() => {
            const count = newMailBuffer.count
            const accounts = [...newMailBuffer.accounts.keys()]
            newMailBuffer.count = 0
            newMailBuffer.accounts.clear()
            newMailBuffer.timer = null
            get().notify(
              'info',
              accounts.length === 1
                ? i18next.t('toast.newMail', { email: accounts[0], count })
                : i18next.t('toast.newMailMany', { count, accounts: accounts.length }),
            )
          }, 1500)
        }
        return
      }
      case 'messages.changed':
        set((s) => ({ messagesChangedTick: s.messagesChangedTick + 1 }))
        return
      case 'mailboxes.updated':
        set((s) => ({ mailboxesTick: s.mailboxesTick + 1 }))
        return
      case 'autoSync.changed':
        set({ autoSync: event.state })
        return
      case 'backend.error':
        get().notify('error', event.message)
        return
    }
  },

  notify(kind, message) {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }].slice(-MAX_TOASTS) }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000)
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))
