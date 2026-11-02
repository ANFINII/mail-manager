import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Outlet } from '@tanstack/react-router'
import { useAppStore } from 'stores/app-store'
import { api } from 'lib/api'
import Toasts from 'components/layout/Toasts'

export default function AppLayout(): React.JSX.Element {
  const { t } = useTranslation()
  const loadAll = useAppStore((s) => s.loadAll)
  const applyEvent = useAppStore((s) => s.applyEvent)
  const loaded = useAppStore((s) => s.loaded)
  const needsAttention = useAppStore((s) => s.stats?.needsAttention ?? 0)

  useEffect(() => {
    const off = api.onEvent(applyEvent)
    void loadAll()
    // backend の起動直後に loadAll が失敗した場合に備えて一度だけ再試行
    const retry = setTimeout(() => {
      if (!useAppStore.getState().loaded) void loadAll()
    }, 1500)
    return () => {
      off()
      clearTimeout(retry)
    }
  }, [applyEvent, loadAll])

  return (
    <div className="app" data-testid="app-root" data-backend={loaded ? 'ready' : 'connecting'}>
      <nav className="nav">
        <div className="brand">{t('app.title')}</div>
        <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: 'active' }}>
          {t('nav.dashboard')}
        </Link>
        <Link to="/search" activeProps={{ className: 'active' }}>
          {t('nav.search')}
        </Link>
        <Link to="/codes" activeProps={{ className: 'active' }}>
          {t('nav.codes')}
        </Link>
        <Link to="/sent" activeProps={{ className: 'active' }}>
          {t('nav.sent')}
        </Link>
        <Link to="/rules" activeProps={{ className: 'active' }}>
          {t('nav.rules')}
        </Link>
        <Link to="/forward-log" activeProps={{ className: 'active' }}>
          {t('nav.forwardLog')}
        </Link>
        <Link to="/history" activeProps={{ className: 'active' }}>
          {t('nav.history')}
        </Link>
        <Link to="/health" activeProps={{ className: 'active' }}>
          {t('nav.health')}
          {needsAttention > 0 && (
            <span className="nav-count" data-testid="nav-health-count">
              {needsAttention}
            </span>
          )}
        </Link>
        <Link to="/accounts" activeProps={{ className: 'active' }}>
          {t('nav.accounts')}
        </Link>
        <Link to="/import" activeProps={{ className: 'active' }}>
          {t('nav.import')}
        </Link>
        <Link to="/connections" activeProps={{ className: 'active' }}>
          {t('nav.connections')}
        </Link>
        <div className="nav-spacer" />
        <Link to="/settings" activeProps={{ className: 'active' }}>
          {t('nav.settings')}
        </Link>
      </nav>
      <main className="main">
        <Outlet />
      </main>
      <Toasts />
    </div>
  )
}
