import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import type { ForwardRule, ForwardRuleField } from '@shared/types'
import { api, errorMessage } from 'lib/api'

/**
 * 動的ルール: 受信メールが条件に一致したとき自動でアクションを実行する。
 * 現在のアクションは「転送」のみ。今後この画面に他のアクション種別を追加していく。
 */
export default function DynamicRulesTemplate() {
  const { t } = useTranslation()
  const notify = useAppStore((s) => s.notify)
  const [rules, setRules] = useState<ForwardRule[]>([])
  const [keyword, setKeyword] = useState('')
  const [field, setField] = useState<ForwardRuleField>('any')
  const [action, setAction] = useState<'forward'>('forward')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .call('forwardRules.list', {})
      .then(setRules)
      .catch((err) => notify('error', errorMessage(err)))
  }, [notify])

  const add = async () => {
    if (!keyword.trim() || !to.trim()) return
    setBusy(true)
    try {
      setRules(
        await api.call('forwardRules.add', {
          keyword: keyword.trim(),
          matchField: field,
          to: to.trim(),
          enabled: true,
        }),
      )
      setKeyword('')
      setTo('')
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
          : t('rules.applied', { forwarded: r.forwarded, rules: r.rules }),
      )
    } catch (err) {
      notify('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
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
          <div className="rule-action">
            <span className="rule-label">{t('rules.then')}</span>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value as 'forward')}
              data-testid="rule-action"
            >
              <option value="forward">{t('rules.actionForward')}</option>
            </select>
            <input
              placeholder={t('rules.to')}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              data-testid="rule-to"
            />
            <button
              className="btn btn-primary"
              onClick={add}
              disabled={busy || !keyword.trim() || !to.trim()}
              data-testid="rule-add"
            >
              {t('rules.add')}
            </button>
          </div>
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
                    {t(
                      `rules.field${r.matchField.charAt(0).toUpperCase() + r.matchField.slice(1)}`,
                    )}{' '}
                    が「{r.keyword}」を含む
                  </td>
                  <td>
                    {t('rules.actionForward')} → {r.to}
                  </td>
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
