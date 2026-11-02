import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import { api, errorMessage } from 'lib/api'
import Modal from 'components/parts/Modal'

/** 選択したアカウントにタグを付ける・外す */
export default function TagAssign(props: { ids: string[]; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const notify = useAppStore((s) => s.notify)
  const accounts = useAppStore((s) => s.accounts)
  const [tag, setTag] = useState('')
  const known = useMemo(() => [...new Set(accounts.flatMap((a) => a.tags))].sort(), [accounts])

  const run = async (mode: 'add' | 'remove') => {
    const tags = tag
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
    if (tags.length === 0) return
    try {
      const r = await api.call('accounts.updateTags', { ids: props.ids, [mode]: tags })
      notify('info', t('tags.updated', { count: r.updated }))
      props.onClose()
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }

  return (
    <Modal data-testid="tag-assign" onBackdropClick={props.onClose}>
      <h2>{t('tags.assignTitle', { count: props.ids.length })}</h2>
      <label className="field-block">
        {t('tags.tag')}
        <input value={tag} onChange={(e) => setTag(e.target.value)} list="known-tags" placeholder={t('tags.placeholder')} autoFocus data-testid="tag-input" />
        <datalist id="known-tags">
          {known.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
      </label>
      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => run('add')} disabled={!tag.trim()} data-testid="tag-add">
          {t('tags.add')}
        </button>
        <button className="btn" onClick={() => run('remove')} disabled={!tag.trim()}>
          {t('tags.remove')}
        </button>
        <span className="spacer" />
        <button className="btn" onClick={props.onClose}>
          {t('common.cancel')}
        </button>
      </div>
    </Modal>
  )
}
