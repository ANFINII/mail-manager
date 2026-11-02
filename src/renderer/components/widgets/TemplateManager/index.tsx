import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import { TEMPLATE_VARIABLES } from '@shared/template'
import type { MailTemplate } from '@shared/types'
import { api, errorMessage } from 'lib/api'

/** 定型文の管理（設定画面） */
export default function TemplateManager(): React.JSX.Element {
  const { t } = useTranslation()
  const notify = useAppStore((s) => s.notify)
  const [list, setList] = useState<MailTemplate[]>([])
  const [editing, setEditing] = useState<{ id?: string; name: string; subject: string; body: string } | null>(null)

  useEffect(() => {
    api
      .call('templates.list', {})
      .then(setList)
      .catch((err) => notify('error', errorMessage(err)))
  }, [notify])

  const save = async () => {
    if (!editing) return
    try {
      setList(await api.call('templates.save', editing))
      setEditing(null)
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }
  const remove = async (id: string) => {
    try {
      setList(await api.call('templates.remove', { id }))
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }

  return (
    <section data-testid="templates">
      <h2>{t('templates.title')}</h2>
      <p className="muted small">
        {t('templates.hint')} {TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(' ')}
      </p>
      {list.length > 0 && (
        <table className="simple-table">
          <tbody>
            {list.map((tpl) => (
              <tr key={tpl.id}>
                <td>{tpl.name}</td>
                <td className="muted">{tpl.subject}</td>
                <td>
                  <button className="link" onClick={() => setEditing({ id: tpl.id, name: tpl.name, subject: tpl.subject, body: tpl.body })}>
                    {t('templates.edit')}
                  </button>{' '}
                  <button className="link" onClick={() => remove(tpl.id)}>
                    {t('common.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing ? (
        <div className="form">
          <label>
            {t('templates.name')}
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} data-testid="template-name" />
          </label>
          <label>
            {t('compose.subject')}
            <input value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} />
          </label>
          <label>
            {t('compose.body')}
            <textarea rows={6} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
          </label>
          <div className="toolbar">
            <button className="btn btn-primary" onClick={save} disabled={!editing.name.trim()}>
              {t('common.save')}
            </button>
            <button className="btn" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button className="btn" onClick={() => setEditing({ name: '', subject: '', body: '' })} data-testid="template-new">
          {t('templates.new')}
        </button>
      )}
    </section>
  )
}
