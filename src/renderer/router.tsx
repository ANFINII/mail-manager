import { createHashHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import AppLayout from 'components/layout/AppLayout'
import AccountDetailTemplate from 'components/templates/account-detail'
import AccountsTemplate from 'components/templates/accounts'
import AuditTemplate from 'components/templates/audit'
import CodesTemplate from 'components/templates/codes'
import ConnectionsTemplate from 'components/templates/connections'
import DashboardTemplate from 'components/templates/dashboard'
import ForwardLogTemplate from 'components/templates/forward-log'
import HealthTemplate from 'components/templates/health'
import HistoryTemplate from 'components/templates/history'
import ImportTemplate from 'components/templates/import'
import DynamicRulesTemplate from 'components/templates/rules'
import SearchTemplate from 'components/templates/search'
import SentTemplate from 'components/templates/sent'
import SettingsTemplate from 'components/templates/settings'

const passthrough = (s: Record<string, unknown>): Record<string, unknown> => s

const rootRoute = createRootRoute({ component: AppLayout })

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: DashboardTemplate })
const accountsRoute = createRoute({ getParentRoute: () => rootRoute, path: 'accounts', component: AccountsTemplate, validateSearch: passthrough })
const accountDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: 'accounts/$id', component: AccountDetailTemplate })
const searchRoute = createRoute({ getParentRoute: () => rootRoute, path: 'search', component: SearchTemplate, validateSearch: passthrough })
const sentRoute = createRoute({ getParentRoute: () => rootRoute, path: 'sent', component: SentTemplate })
const rulesRoute = createRoute({ getParentRoute: () => rootRoute, path: 'rules', component: DynamicRulesTemplate })
const healthRoute = createRoute({ getParentRoute: () => rootRoute, path: 'health', component: HealthTemplate })
const forwardLogRoute = createRoute({ getParentRoute: () => rootRoute, path: 'forward-log', component: ForwardLogTemplate })
const codesRoute = createRoute({ getParentRoute: () => rootRoute, path: 'codes', component: CodesTemplate })
const historyRoute = createRoute({ getParentRoute: () => rootRoute, path: 'history', component: HistoryTemplate })
const connectionsRoute = createRoute({ getParentRoute: () => rootRoute, path: 'connections', component: ConnectionsTemplate })
const auditRoute = createRoute({ getParentRoute: () => rootRoute, path: 'audit', component: AuditTemplate })
const importRoute = createRoute({ getParentRoute: () => rootRoute, path: 'import', component: ImportTemplate })
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: 'settings', component: SettingsTemplate })

const routeTree = rootRoute.addChildren([
  indexRoute,
  accountsRoute,
  accountDetailRoute,
  searchRoute,
  sentRoute,
  rulesRoute,
  codesRoute,
  historyRoute,
  connectionsRoute,
  auditRoute,
  healthRoute,
  forwardLogRoute,
  importRoute,
  settingsRoute,
])

export const router = createRouter({ routeTree, history: createHashHistory() })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
