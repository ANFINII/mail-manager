import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import type { AccountSummary } from '@shared/types'
import { api, errorMessage } from 'lib/api'

/** アカウント詳細: タグ（追加・削除）とメモ */
export default function TagsNoteEditor({ account }: { account: AccountSummary }): React.JSX.Element {
  const { t } = useTranslation()
  const notify = useAppStore((s) => s.notify)
  const [tag, setTag] = useState('')
  const [note, setNote] = useState(account.note ?? '')
  useEffect(() => setNote(account.note ?? ''), [account.id, account.note])

  const update = async (add: string[], remove: string[] = []) => {
    try {
      await api.call('accounts.updateTags', { ids: [account.id], add, remove })
      setTag('')
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }
  const saveNote = async () => {
    try {
      await api.call('accounts.setNote', { id: account.id, note })
      notify('info', t('tags.noteSaved'))
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }

  return (
    <section className="tags-note" data-testid="tags-note">
      <div className="tag-list">
        <span className="muted small">{t('tags.title')}:</span>
        {account.tags.map((tg) => (
          <span key={tg} className="tag-chip">
            {tg}
            <button className="tag-x" onClick={() => update([], [tg])} aria-label={t('tags.remove')}>
              ×
            </button>
          </span>
        ))}
        <input
          className="tag-new"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && tag.trim()) void update([tag])
          }}
          placeholder={t('tags.addPlaceholder')}
          data-testid="tag-new"
        />
      </div>
      <label className="field-block">
        {t('tags.note')}
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-testid="account-note" />
      </label>
      {note !== (account.note ?? '') && (
        <button className="btn btn-small" onClick={saveNote}>
          {t('common.save')}
        </button>
      )}
    </section>
  )
}
