import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import { api, errorMessage } from 'lib/api'
import Button from 'components/parts/Button'
import Modal from 'components/parts/Modal'

interface Props {
  onClose: () => void
}

/** グループの作成・改名・削除。削除しても所属アカウントは消えず、グループなしに戻る。 */
export default function GroupManager(props: Props): React.JSX.Element {
  const { onClose } = props
  const { t } = useTranslation()
  const groups = useAppStore((s) => s.groups)
  const notify = useAppStore((s) => s.notify)
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<string>) => {
    setBusy(true)
    try {
      notify('info', await fn())
    } catch (err) {
      notify('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const create = () => {
    const n = name.trim()
    if (!n) return
    void run(async () => {
      await api.call('groups.create', { name: n })
      setName('')
      return t('groups.created', { name: n })
    })
  }
  const rename = () => {
    if (!editing) return
    const n = editing.name.trim()
    if (!n) return
    void run(async () => {
      await api.call('groups.rename', { id: editing.id, name: n })
      setEditing(null)
      return t('groups.renamed')
    })
  }
  const remove = (id: string, groupName: string) => {
    if (!window.confirm(t('groups.confirmRemove', { name: groupName }))) return
    void run(async () => {
      await api.call('groups.remove', { id })
      return t('groups.removed')
    })
  }

  return (
    <Modal data-testid="group-manager-dialog" onBackdropClick={onClose}>
      <h2>{t('groups.title')}</h2>
      <div className="form-row">
        <input
          className="grow"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create()
          }}
          placeholder={t('groups.newName')}
          data-testid="group-new-name"
          autoFocus
        />
        <Button variant="primary" onClick={create} disabled={busy || !name.trim()} data-testid="group-create">
          {t('groups.create')}
        </Button>
      </div>
      {groups.length === 0 ? (
        <p className="muted">{t('groups.empty')}</p>
      ) : (
        <ul className="plain-list" data-testid="group-list">
          {groups.map((g) => (
            <li key={g.id} className="form-row" data-testid="group-item" data-name={g.name}>
              {editing?.id === g.id ? (
                <>
                  <input
                    className="grow"
                    value={editing.name}
                    onChange={(e) => setEditing({ id: g.id, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') rename()
                      if (e.key === 'Escape') setEditing(null)
                    }}
                    data-testid="group-rename-input"
                    autoFocus
                  />
                  <Button variant="primary" size="sm" onClick={rename} disabled={busy}>
                    {t('common.save')}
                  </Button>
                  <Button size="sm" onClick={() => setEditing(null)} disabled={busy}>
                    {t('common.cancel')}
                  </Button>
                </>
              ) : (
                <>
                  <span className="grow">
                    <b>{g.name}</b> <span className="muted small">{t('groups.accounts', { count: g.accountCount })}</span>
                  </span>
                  <Button size="sm" onClick={() => setEditing({ id: g.id, name: g.name })} disabled={busy}>
                    {t('groups.rename')}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => remove(g.id, g.name)} disabled={busy}>
                    {t('groups.remove')}
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="toolbar">
        <Button onClick={onClose} disabled={busy}>
          {t('common.close')}
        </Button>
      </div>
    </Modal>
  )
}
