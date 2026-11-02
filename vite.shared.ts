import { fileURLToPath } from 'node:url'
import pkg from './package.json'

const abs = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

export const srcAlias = {
  '@shared': abs('./src/shared'),
  '@backend': abs('./src/backend'),
}

// レンダラー用エイリアス（MyUs frontend の bare エイリアス構成に準拠）
export const rendererAlias = {
  ...srcAlias,
  components: abs('./src/renderer/components'),
  widgets: abs('./src/renderer/components/widgets'),
  layout: abs('./src/renderer/components/layout'),
  hooks: abs('./src/renderer/components/hooks'),
  pages: abs('./src/renderer/pages'),
  utils: abs('./src/renderer/utils'),
  lib: abs('./src/renderer/lib'),
  styles: abs('./src/renderer/styles'),
  stores: abs('./src/renderer/stores'),
  i18n: abs('./src/renderer/i18n'),
}

const deps = Object.keys(pkg.dependencies)

// package.json の dependencies（サブパス含む）と node:sqlite はバンドルせず、
// パッケージ済みアプリの node_modules / Node 本体から読み込む。
// imapflow などは動的 require を含むためバンドルすると壊れる。
export const nodeExternals = (id: string): boolean =>
  id === 'node:sqlite' || deps.some((d) => id === d || id.startsWith(`${d}/`))
