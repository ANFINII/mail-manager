import { useLocation, useParams as useTsParams, useRouter } from '@tanstack/react-router'

/**
 * react-router 互換の薄いフック群。
 * ルーティング基盤は TanStack Router（hash history）だが、テンプレート側の
 * 呼び出し方（文字列パスでの遷移 / URLSearchParams）を維持するためのアダプタ。
 */

/** `navigate('/path?query')` 形式の文字列遷移を提供する。 */
export function useNavigate(): (to: string) => void {
  const router = useRouter()
  return (to: string) => router.history.push(to)
}

/** 現在のパスパラメータを `{ id: '...' }` の形で返す。 */
export function useParams(): Record<string, string> {
  return useTsParams({ strict: false }) as Record<string, string>
}

/** `[URLSearchParams, setParams]` を返す（setParams はクエリを置き換える）。 */
export function useSearchParams(): [URLSearchParams, (next: Record<string, string>) => void] {
  const router = useRouter()
  const searchStr = useLocation({ select: (l) => l.searchStr })
  const pathname = useLocation({ select: (l) => l.pathname })
  const params = new URLSearchParams(searchStr)
  const setParams = (next: Record<string, string>) => {
    const qs = new URLSearchParams(next).toString()
    router.history.push(qs ? `${pathname}?${qs}` : pathname)
  }
  return [params, setParams]
}
