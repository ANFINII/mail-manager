import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import type {
  ForwardRule,
  ForwardRuleField,
  ForwardRuleInput,
  RuleAction,
  RulePreview,
} from '@shared/types'
import { api, errorMessage } from 'lib/api'
import { formatDateTime } from 'utils/format'

const ACTIONS: RuleAction[] = ['forward', 'mark_read', 'flag', 'move', 'delete', 'webhook']
const ACTION_KEY: Record<RuleAction, string> = {
  forward: 'rules.actionForward',
  mark_read: 'rules.actionMarkRead',
  flag: 'rules.actionFlag',
  move: 'rules.actionMove',
  delete: 'rules.actionDelete',
  webhook: 'rules.actionWebhook',
}
const fieldKey = (f: ForwardRuleField) => `rules.field${f.charAt(0).toUpperCase() + f.slice(1)}`

/**
 * 動的ルール: 受信メールが条件に一致したとき自動でアクションを実行する。
 * 保存前に「試算（ドライラン）」で一致件数と実際に影響する件数を確認できる。
 */
export default function DynamicRulesTemplate() {
  const { t, i18n } = useTranslation()
  const notify = useAppStore((s) => s.notify)
  const groups = useAppStore((s) => s.groups)
  const locale = i18n.language === 'en' ? 'en-US' : 'ja-JP'
  const [rules, setRules] = useState<ForwardRule[]>([])
  const [keyword, setKeyword] = useState('')
  const [field, setField] = useState<ForwardRuleField>('any')
  const [action, setAction] = useState<RuleAction>('forward')
  const [arg, setArg] = useState('')
  const [groupId, setGroupId] = useState('')
  const [applyExisting, setApplyExisting] = useState(true)
  const [preview, setPreview] = useState<RulePreview | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .call('forwardRules.list', {})
      .then(setRules)
      .catch((err) => notify('error', errorMessage(err)))
  }, [notify])

  // 条件を変えたら試算結果は古くなる
  useEffect(() => setPreview(null), [keyword, field, action, arg, groupId, applyExisting])

  // 破壊的なアクション（移動・削除）は既定で既存メールに適用しない
  const changeAction = (a: RuleAction) => {
    setAction(a)
    setArg('')
    setApplyExisting(a === 'forward' || a === 'mark_read' || a === 'flag')
  }

  const argRequired = action === 'forward' || action === 'move'
  const canSubmit = !!keyword.trim() && (!argRequired || !!arg.trim())
  const input = (): ForwardRuleInput => ({
    keyword: keyword.trim(),
    matchField: field,
    to: arg.trim(),
    enabled: true,
    action,
    groupId: groupId || null,
    applyExisting,
  })

  const runPreview = async () => {
    setBusy(true)
    try {
      setPreview(await api.call('forwardRules.preview', input()))
    } catch (err) {
      notify('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const add = async () => {
    if (!canSubmit) return
    setBusy(true)
    try {
      setRules(await api.call('forwardRules.add', input()))
      setKeyword('')
      setArg('')
      setPreview(null)
    } catch (err) {
      notify('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const toggle = async (id: string, enabled: boolean) => {
    try {
      setRules(await api.call('forwardRules.setEnabled', { id, enabled }))
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }
  const remove = async (id: string) => {
    try {
      setRules(await api.call('forwardRules.remove', { id }))
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }
  const applyNow = async () => {
    setBusy(true)
    try {
      const r = await api.call('forwardRules.apply', {})
      notify(
        'info',
        r.deferred > 0
          ? t('rules.appliedDeferred', { forwarded: r.forwarded, rules: r.rules, deferred: r.deferred })
          : r.actioned
            ? t('rules.appliedActions', { forwarded: r.forwarded, actioned: r.actioned, rules: r.rules })
            : t('rules.applied', { forwarded: r.forwarded, rules: r.rules }),
      )
    } catch (err) {
      notify('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const groupName = (id: string | null) => groups.find((g) => g.id === id)?.name ?? '?'
  const describeAction = (r: ForwardRule) => {
    const label = t(ACTION_KEY[r.action])
    if (r.action === 'forward' || r.action === 'move') return `${label} → ${r.to}`
    if (r.action === 'webhook') return `${label}${r.to ? ` → ${r.to}` : ''}`
    return label
  }

  return (
    <div className="page" data-testid="rules">
      <div className="page-head">
        <h1>{t('nav.rules')}</h1>
        <span className="spacer" />
        <button
          className="btn"
          onClick={applyNow}
          disabled={busy || rules.length === 0}
          data-testid="rule-apply"
        >
          {t('rules.applyNow')}
        </button>
      </div>
      <p className="muted">{t('rules.pageHint')}</p>

      <section>
        <h2>{t('rules.addTitle')}</h2>
        <div className="rule-form">
          <div className="rule-cond">
            <span className="rule-label">{t('rules.when')}</span>
            <select
              value={field}
              onChange={(e) => setField(e.target.value as ForwardRuleField)}
              data-testid="rule-field"
            >
              <option value="any">{t('rules.fieldAny')}</option>
              <option value="subject">{t('rules.fieldSubject')}</option>
              <option value="from">{t('rules.fieldFrom')}</option>
              <option value="body">{t('rules.fieldBody')}</option>
            </select>
            <span className="rule-label">{t('rules.contains')}</span>
            <input
              placeholder={t('rules.keyword')}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              data-testid="rule-keyword"
            />
          </div>
          <div className="rule-cond">
            <span className="rule-label">{t('rules.scope')}</span>
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)} data-testid="rule-group">
              <option value="">{t('rules.scopeAll')}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {t('rules.scopeGroup', { name: g.name })}
                </option>
              ))}
            </select>
          </div>
          <div className="rule-action">
            <span className="rule-label">{t('rules.then')}</span>
            <select
              value={action}
              onChange={(e) => changeAction(e.target.value as RuleAction)}
              data-testid="rule-action"
            >
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {t(ACTION_KEY[a])}
                </option>
              ))}
            </select>
            {(action === 'forward' || action === 'move' || action === 'webhook') && (
              <input
                placeholder={
                  action === 'forward'
                    ? t('rules.to')
                    : action === 'move'
                      ? t('rules.moveTo')
                      : t('rules.webhookUrl')
                }
                value={arg}
                onChange={(e) => setArg(e.target.value)}
                data-testid="rule-to"
              />
            )}
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={applyExisting}
              onChange={(e) => setApplyExisting(e.target.checked)}
              data-testid="rule-apply-existing"
            />{' '}
            {t('rules.applyExisting')}
          </label>
          <div className="toolbar">
            <button className="btn" onClick={runPreview} disabled={busy || !canSubmit} data-testid="rule-preview">
              {t('rules.preview')}
            </button>
            <button
              className="btn btn-primary"
              onClick={add}
              disabled={busy || !canSubmit}
              data-testid="rule-add"
            >
              {t('rules.add')}
            </button>
          </div>
          {preview && (
            <div className="rule-preview" data-testid="rule-preview-result">
              <div>
                {t('rules.previewResult', { matched: preview.matched, wouldApply: preview.wouldApply })}
                {!applyExisting && <span className="muted"> {t('rules.previewNoExisting')}</span>}
              </div>
              {preview.samples.length > 0 && (
                <>
                  <div className="muted small">{t('rules.previewSamples')}</div>
                  <ul>
                    {preview.samples.map((s) => (
                      <li key={s.id}>
                        <span className="muted small">{formatDateTime(s.date, locale)}</span>{' '}
                        <span className="mono small">{s.accountEmail}</span> {s.from ?? ''} —{' '}
                        {s.subject}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      </section>

      <section>
        <h2>{t('rules.listTitle')}</h2>
        {rules.length === 0 ? (
          <p className="muted">{t('rules.empty')}</p>
        ) : (
          <table className="simple-table" data-testid="rule-list">
            <thead>
              <tr>
                <th>{t('rules.enabled')}</th>
                <th>{t('rules.condition')}</th>
                <th>{t('rules.actionCol')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={(e) => toggle(r.id, e.target.checked)}
                    />
                  </td>
                  <td>
                    {t('rules.containsText', { field: t(fieldKey(r.matchField)), keyword: r.keyword })}
                    {r.groupId && (
                      <span className="muted small"> · {t('rules.scopeGroup', { name: groupName(r.groupId) })}</span>
                    )}
                    {!r.applyExisting && <span className="muted small"> · {t('rules.newOnly')}</span>}
                  </td>
                  <td>{describeAction(r)}</td>
                  <td>
                    <button className="link" onClick={() => remove(r.id)}>
                      {t('rules.remove')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
