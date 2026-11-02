import { fixupConfigRules, fixupPluginRules } from '@eslint/compat'
import js from '@eslint/js'
import tsEsLintPlugin from '@typescript-eslint/eslint-plugin'
import importPlugin from 'eslint-plugin-import'
import pluginReact from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import unusedPlugin from 'eslint-plugin-unused-imports'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// MyUs frontend の eslint 設定に準拠（Next.js 関連は不使用のため除外）。
// スタイル系ルールは .prettierrc（semi なし / single quote / trailingComma all）と一致させている。

/** 共通のスタイル/品質ルール */
const commonRules = {
  semi: ['error', 'never'], // セミコロンを不要に
  quotes: ['error', 'single', { avoidEscape: true }], // シングルクォートを強制
  eqeqeq: ['error', 'always'], // 厳密な等価演算子を強制
  'no-console': ['warn'], // console.log の使用を警告
  'no-multi-spaces': ['error'], // 複数スペースを禁止
  'no-multiple-empty-lines': ['error', { max: 1, maxBOF: 0, maxEOF: 0 }], // 連続する空行を禁止
  'prefer-const': ['error'], // 再代入されない変数に const を強制
  'no-irregular-whitespace': ['error', { skipStrings: true, skipComments: true, skipRegExps: true, skipTemplates: true }], // 文字列/正規表現内の特殊空白（BOM 等）は許可
  'comma-dangle': ['error', 'always-multiline'], // 末尾カンマを強制
  'object-curly-spacing': ['error', 'always'], // オブジェクトの中括弧内にスペースを強制
  'eol-last': ['error', 'always'], // ファイル末尾に空行を強制
  'react/jsx-uses-react': 'off', // React の import が不要
  'react/react-in-jsx-scope': 'off', // React の import が不要
  'react/prop-types': 'off', // 型は TypeScript で担保
  'react-hooks/rules-of-hooks': 'error',
  'react-hooks/exhaustive-deps': 'warn', // Hooks の依存配列で警告
  '@typescript-eslint/no-explicit-any': 'warn', // any の使用を警告
  '@typescript-eslint/no-unused-vars': 'off', // unused-imports に委譲
  'unused-imports/no-unused-imports': 'error', // 未使用の import を禁止
  'unused-imports/no-unused-vars': ['warn', { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' }],
  'import/order': [
    'error',
    {
      groups: ['builtin', 'external', 'internal', ['sibling', 'index'], 'parent'],
      alphabetize: { order: 'asc', caseInsensitive: false },
      'newlines-between': 'never',
      pathGroupsExcludedImportTypes: ['builtin'],
      pathGroups: [
        { pattern: '{react,react/**,react-dom/**,react-**}', group: 'builtin', position: 'before' },
        { pattern: '{@shared/**,@backend/**}', group: 'internal', position: 'before' },
        { pattern: 'lib/**', group: 'internal', position: 'before' },
        { pattern: 'types/**', group: 'internal', position: 'before' },
        { pattern: 'utils/**', group: 'internal', position: 'before' },
        { pattern: 'pages/**', group: 'internal', position: 'before' },
        { pattern: 'components/hooks/**', group: 'internal', position: 'before' },
        { pattern: 'components/provider/**', group: 'internal', position: 'before' },
        { pattern: '{components/layout,components/layout/**}', group: 'internal', position: 'before' },
        { pattern: 'components/parts/**', group: 'sibling', position: 'before' },
        { pattern: 'components/widgets/**', group: 'sibling', position: 'before' },
        { pattern: 'components/templates/**', group: 'sibling', position: 'before' },
      ],
    },
  ],
}

/** @type {import('eslint').Linter.Config[]} */
export default [
  { ignores: ['out/**', '.vite/**', 'dist/**', 'node_modules/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...fixupConfigRules(pluginReact.configs.flat.recommended),
  {
    files: ['**/*.{ts,tsx}'],
    settings: { react: { version: 'detect' } },
    plugins: {
      react: fixupPluginRules(pluginReact),
      'react-hooks': reactHooks,
      import: fixupPluginRules(importPlugin),
      'unused-imports': unusedPlugin,
      '@typescript-eslint': tsEsLintPlugin,
    },
    rules: commonRules,
  },
  {
    // レンダラー（ブラウザ環境）
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
  },
  {
    // バックエンド / 共有 / スクリプト（Node 環境）
    files: ['src/backend/**/*.ts', 'src/shared/**/*.ts', 'src/main/**/*.ts', 'src/preload/**/*.ts', 'scripts/**/*.ts', '*.{js,mjs,cjs,ts}'],
    languageOptions: { ecmaVersion: 2022, globals: globals.node },
  },
]
