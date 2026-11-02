import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from 'lib/api'

/** 認証コード・確認リンクの表示（ワンクリックでコピー / ブラウザで開く） */
export default function CodeChip({ code, link }: { code: string | null; link: string | null }): React.JSX.Element | null {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  if (!code && !link) return null
  const copy = async () => {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // クリップボードが使えない環境では何もしない（コードは画面に表示されている）
    }
  }
  return (
    <span className="code-chip-wrap">
      {code && (
        <button type="button" className="code-chip" onClick={copy} title={t('codes.copy')} data-testid="code-chip">
          <span className="mono">{code}</span>
          <span className="code-chip-action">{copied ? t('codes.copied') : t('codes.copy')}</span>
        </button>
      )}
      {link && (
        <button
          type="button"
          className="btn btn-small"
          onClick={() => void api.openExternal(link)}
          title={link}
          data-testid="code-link"
        >
          {t('codes.openLink')}
        </button>
      )}
    </span>
  )
}
