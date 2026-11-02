import { initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import { en } from './en'
import { ja } from './ja'

export type Language = 'ja' | 'en';

function savedLanguage(): Language {
  try {
    const v = localStorage.getItem('mm.lang')
    return v === 'en' ? 'en' : 'ja'
  } catch {
    return 'ja'
  }
}

void i18next.use(initReactI18next).init({
  resources: { ja: { translation: ja }, en: { translation: en } },
  lng: savedLanguage(),
  fallbackLng: 'ja',
  interpolation: { escapeValue: false },
})

export function setLanguage(lng: Language): void {
  void i18next.changeLanguage(lng)
  try {
    localStorage.setItem('mm.lang', lng)
  } catch {
    // ignore
  }
}

export function currentLanguage(): Language {
  return i18next.language === 'en' ? 'en' : 'ja'
}

export default i18next
