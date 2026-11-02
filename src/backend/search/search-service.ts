import type { AccountGroup, MessageSummary, SearchQuery, SearchResult } from '@shared/types'
import type { MessageRepository } from '../db/message-repository'
import { toMessageSummary } from '../messages/message-service'

/**
 * 横断検索。DB 実装（SQLite FTS5 / PostgreSQL LIKE）は MessageRepository に閉じ込め、
 * 将来 Meilisearch 等に差し替えるときはこのサービスの中だけを変える。
 */
export class SearchService {
  constructor(private readonly repo: MessageRepository) {}

  async query(q: SearchQuery): Promise<SearchResult> {
    const started = Date.now()
    const { rows, total } = await this.repo.search(q)
    const items: MessageSummary[] = rows.map(toMessageSummary)
    return {
      items,
      total,
      page: Math.max(1, q.page || 1),
      pageSize: Math.min(500, Math.max(1, q.pageSize || 50)),
      tookMs: Date.now() - started,
    }
  }

  /** 検索条件に一致するメールを、アカウント別に件数集計して返す（受信メールのグループ表示用） */
  async accountGroups(q: SearchQuery): Promise<AccountGroup[]> {
    return this.repo.accountGroups(q)
  }

  /** ページングせずに全件を順に返す（エクスポート用） */
  async *iterate(q: SearchQuery, pageSize = 500): AsyncGenerator<MessageSummary> {
    let page = 1
    while (true) {
      const r = await this.query({ ...q, page, pageSize })
      for (const item of r.items) yield item
      if (r.items.length < pageSize) return
      page++
    }
  }
}
