import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { renderTemplate, type TemplateVariables } from '@shared/template'
import type { MailTemplate } from '@shared/types'
import { api } from 'lib/api'

/** 定型文を選んで件名・本文に差し込む（差し込み項目はその場で置き換える） */
export default function TemplatePicker(props: {
  vars: TemplateVariables
  onPick: (subject: string, body: string) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [templates, setTemplates] = useState<MailTemplate[]>([])
  useEffect(() => {
    api
      .call('templates.list', {})
      .then(setTemplates)
      .catch(() => undefined)
  }, [])
  if (templates.length === 0) return null
  return (
    <label className="field-block">
      {t('templates.use')}
      <select
        value=""
        onChange={(e) => {
          const tpl = templates.find((x) => x.id === e.target.value)
          if (tpl) props.onPick(renderTemplate(tpl.subject, props.vars), renderTemplate(tpl.body, props.vars))
        }}
        data-testid="template-picker"
      >
        <option value="">{t('templates.choose')}</option>
        {templates.map((tpl) => (
          <option key={tpl.id} value={tpl.id}>
            {tpl.name}
          </option>
        ))}
      </select>
    </label>
  )
}
