import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import { api, errorMessage } from 'lib/api'
import Button from 'components/parts/Button'
import Modal from 'components/parts/Modal'

const NEW = '__new__'
const NONE = '__none__'

interface Props {
  /** 対象アカウント ID */
  ids: string[]
  onCancel: () => void
  onDone: () => void
}

/** 選択したアカウントを既存グループへ移動するか、新しいグループを作って移動するダイアログ。 */
export default function GroupAssign(props: Props): React.JSX.Element {
  const { ids, onCancel, onDone } = props
  const { t } = useTranslation()
  const groups = useAppStore((s) => s.groups)
  const notify = useAppStore((s) => s.notify)
  const [choice, setChoice] = useState<string>(groups[0]?.id ?? NEW)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  const canApply = choice === NEW ? newName.trim().length > 0 : true

  const apply = async () => {
    setBusy(true)
    try {
      let groupId: string | null
      if (choice === NONE) groupId = null
      else if (choice === NEW) {
        const list = await api.call('groups.create', { name: newName.trim() })
        const created = list.find((g) => g.name.toLowerCase() === newName.trim().toLowerCase())
        if (!created) throw new Error(t('groups.nameRequired'))
        groupId = created.id
      } else groupId = choice
      const r = await api.call('accounts.setGroup', { ids, groupId })
      notify('info', groupId ? t('accounts.groupAssigned', { count: r.updated }) : t('accounts.groupCleared', { count: r.updated }))
      onDone()
    } catch (err) {
      notify('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal data-testid="group-assign-dialog" onBackdropClick={onCancel}>
      <h2>{t('groups.assignTitle', { count: ids.length })}</h2>
      <label className="field-block">
        {t('groups.choose')}
        <select value={choice} onChange={(e) => setChoice(e.target.value)} data-testid="group-assign-select">
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} ({g.accountCount})
            </option>
          ))}
          <option value={NEW}>{t('groups.newGroup')}</option>
          <option value={NONE}>{t('groups.unassign')}</option>
        </select>
      </label>
      {choice === NEW && (
        <label className="field-block">
          {t('groups.newName')}
          <input value={newName} onChange={(e) => setNewName(e.target.value)} data-testid="group-assign-new-name" autoFocus />
        </label>
      )}
      <div className="toolbar">
        <Button variant="primary" onClick={apply} disabled={busy || !canApply} data-testid="group-assign-apply">
          {t('groups.apply')}
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </Button>
      </div>
    </Modal>
  )
}
