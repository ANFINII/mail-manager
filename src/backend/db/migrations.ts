import { sql, type Kysely } from 'kysely'
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration'

export type DbDriver = 'sqlite' | 'postgres';
let currentDriver: DbDriver = 'sqlite'
export function setMigrationDriver(driver: DbDriver): void {
  currentDriver = driver
}

/**
 * マイグレーションはコード内に持つ（パッケージ後にファイルシステムを走査しないため）。
 * SQLite / PostgreSQL 両方で通る型だけを使う。
 */
const migrations: Record<string, Migration> = {
  '0001_accounts_settings': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('accounts')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('email', 'text', (c) => c.notNull().unique())
        .addColumn('provider', 'text', (c) => c.notNull())
        .addColumn('auth_type', 'text', (c) => c.notNull())
        .addColumn('imap_host', 'text', (c) => c.notNull())
        .addColumn('imap_port', 'integer', (c) => c.notNull())
        .addColumn('imap_secure', 'text', (c) => c.notNull())
        .addColumn('smtp_host', 'text')
        .addColumn('smtp_port', 'integer')
        .addColumn('smtp_secure', 'text')
        .addColumn('proxy', 'text')
        .addColumn('encrypted_credentials', 'text', (c) => c.notNull())
        .addColumn('enabled', 'integer', (c) => c.notNull().defaultTo(1))
        .addColumn('status', 'text', (c) => c.notNull().defaultTo('untested'))
        .addColumn('auth_status', 'text', (c) => c.notNull().defaultTo('untested'))
        .addColumn('last_error', 'text')
        .addColumn('last_error_at', 'text')
        .addColumn('last_success_at', 'text')
        .addColumn('last_sync_at', 'text')
        .addColumn('retry_count', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('message_count', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute()
      await db.schema.createIndex('idx_accounts_status').on('accounts').column('status').execute()
      await db.schema
        .createIndex('idx_accounts_auth_status')
        .on('accounts')
        .column('auth_status')
        .execute()
      await db.schema
        .createTable('settings')
        .addColumn('key', 'text', (c) => c.primaryKey())
        .addColumn('value', 'text', (c) => c.notNull())
        .execute()
    },
    async down(db: Kysely<unknown>) {
      await db.schema.dropTable('settings').execute()
      await db.schema.dropTable('accounts').execute()
    },
  },
}

migrations['0002_mailboxes_messages'] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('mailboxes')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('account_id', 'text', (c) =>
        c.notNull().references('accounts.id').onDelete('cascade'),
      )
      .addColumn('path', 'text', (c) => c.notNull())
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('delimiter', 'text')
      .addColumn('special_use', 'text')
      .addColumn('uid_validity', 'integer')
      .addColumn('last_sync_uid', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('total_messages', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('last_sync_at', 'text')
      .addColumn('sync_enabled', 'integer', (c) => c.notNull().defaultTo(1))
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addColumn('updated_at', 'text', (c) => c.notNull())
      .addUniqueConstraint('uq_mailboxes_account_path', ['account_id', 'path'])
      .execute()

    await db.schema
      .createTable('messages')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('account_id', 'text', (c) =>
        c.notNull().references('accounts.id').onDelete('cascade'),
      )
      .addColumn('mailbox_id', 'text', (c) =>
        c.notNull().references('mailboxes.id').onDelete('cascade'),
      )
      .addColumn('remote_uid', 'integer', (c) => c.notNull())
      .addColumn('message_id', 'text')
      .addColumn('in_reply_to', 'text')
      .addColumn('from_address', 'text')
      .addColumn('from_name', 'text')
      .addColumn('to_addresses', 'text', (c) => c.notNull().defaultTo('[]'))
      .addColumn('cc_addresses', 'text', (c) => c.notNull().defaultTo('[]'))
      .addColumn('subject', 'text', (c) => c.notNull().defaultTo(''))
      .addColumn('text_body', 'text')
      .addColumn('html_body', 'text')
      .addColumn('snippet', 'text', (c) => c.notNull().defaultTo(''))
      .addColumn('date', 'text')
      .addColumn('internal_date', 'text')
      .addColumn('size', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('has_attachments', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('seen', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('flagged', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('answered', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addColumn('updated_at', 'text', (c) => c.notNull())
      // 重複判定は account + mailbox + UID（Message-ID だけでは判定しない）
      .addUniqueConstraint('uq_messages_account_mailbox_uid', [
        'account_id',
        'mailbox_id',
        'remote_uid',
      ])
      .execute()
    await db.schema.createIndex('idx_messages_date').on('messages').column('date').execute()
    await db.schema
      .createIndex('idx_messages_account_date')
      .on('messages')
      .columns(['account_id', 'date'])
      .execute()
    await db.schema
      .createIndex('idx_messages_mailbox')
      .on('messages')
      .column('mailbox_id')
      .execute()
    await db.schema
      .createIndex('idx_messages_message_id')
      .on('messages')
      .column('message_id')
      .execute()
    await db.schema
      .createIndex('idx_messages_from')
      .on('messages')
      .column('from_address')
      .execute()

    await db.schema
      .createTable('attachments')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('message_id', 'text', (c) =>
        c.notNull().references('messages.id').onDelete('cascade'),
      )
      .addColumn('filename', 'text', (c) => c.notNull())
      .addColumn('content_type', 'text', (c) => c.notNull())
      .addColumn('size', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('part_id', 'text')
      .addColumn('content_id', 'text')
      .addColumn('storage_path', 'text')
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute()
    await db.schema
      .createIndex('idx_attachments_message')
      .on('attachments')
      .column('message_id')
      .execute()

    if (currentDriver === 'sqlite') {
      // 全文検索: trigram トークナイザーは日本語などスペースで区切られない言語でも部分一致できる
      await sql`CREATE VIRTUAL TABLE messages_fts USING fts5(message_id UNINDEXED, subject, from_text, to_text, body, attachments, tokenize='trigram')`.execute(
        db,
      )
      await sql`CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN DELETE FROM messages_fts WHERE message_id = old.id; END`.execute(
        db,
      )
    } else {
      await sql`CREATE INDEX idx_messages_subject_trgm ON messages (lower(subject))`.execute(db)
    }
  },
  async down(db: Kysely<unknown>) {
    if (currentDriver === 'sqlite') {
      await sql`DROP TRIGGER IF EXISTS messages_fts_ad`.execute(db)
      await sql`DROP TABLE IF EXISTS messages_fts`.execute(db)
    }
    await db.schema.dropTable('attachments').execute()
    await db.schema.dropTable('messages').execute()
    await db.schema.dropTable('mailboxes').execute()
  },
}

migrations['0003_forwards'] = {
  async up(db: Kysely<unknown>) {
    // 転送履歴。(message_id, to_address) で重複転送を防ぐ。
    await db.schema
      .createTable('forwards')
      .addColumn('message_id', 'text', (c) =>
        c.notNull().references('messages.id').onDelete('cascade'),
      )
      .addColumn('to_address', 'text', (c) => c.notNull())
      .addColumn('forwarded_at', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('pk_forwards', ['message_id', 'to_address'])
      .execute()
    await db.schema.createIndex('idx_forwards_to').on('forwards').column('to_address').execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('forwards').execute()
  },
}

migrations['0004_forward_targets'] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('forward_targets')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('address', 'text', (c) => c.notNull().unique())
      .addColumn('label', 'text')
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('forward_targets').execute()
  },
}

migrations['0005_forward_rules'] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('forward_rules')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('keyword', 'text', (c) => c.notNull())
      .addColumn('match_field', 'text', (c) => c.notNull().defaultTo('any'))
      .addColumn('to_address', 'text', (c) => c.notNull())
      .addColumn('enabled', 'integer', (c) => c.notNull().defaultTo(1))
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('forward_rules').execute()
  },
}

migrations['0006_enable_auto_sync'] = {
  async up(db: Kysely<unknown>) {
    // 既存インストールで自動同期が無効(0)のまま保存されている場合、既定の 15 分へ引き上げて
    // 自動受信を有効にする。ユーザーが後から変更した値（0 以外）はそのまま維持する。
    await sql`UPDATE settings SET value = '15' WHERE key = 'autoSyncIntervalMin' AND value = '0'`.execute(db)
  },
  async down() {
    // 値の変更のみで元の値は保持していないため、ロールバックでは何もしない。
  },
}

migrations['0007_auto_sync_one_minute'] = {
  async up(db: Kysely<unknown>) {
    // 自動受信をほぼリアルタイム（1 分間隔）にする。0006 で自動設定した 15 分の値を 1 分へ引き下げる。
    // ユーザーが明示的に無効化(0)した場合や 15 以外の任意の値はそのまま維持する。
    await sql`UPDATE settings SET value = '1' WHERE key = 'autoSyncIntervalMin' AND value = '15'`.execute(db)
  },
  async down() {
    // 値の変更のみでロールバックはしない。
  },
}

migrations['0008_auto_sync_seconds'] = {
  async up(db: Kysely<unknown>) {
    // 既存インストール（settings に行がある）で秒間隔が未設定なら 15 秒を設定する。
    // 新規DB（settings が空）には入れないので、初期値は分設定（既定 1 分）のまま。
    await sql`
      INSERT INTO settings (key, value)
      SELECT 'autoSyncIntervalSec', '15'
      WHERE EXISTS (SELECT 1 FROM settings)
        AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'autoSyncIntervalSec')
    `.execute(db)
  },
  async down() {
    // 追加した設定行は残す（ロールバックしない）。
  },
}

migrations['0009_fts_rowid'] = {
  async up(db: Kysely<unknown>) {
    // 削除の高速化。従来の削除トリガー `DELETE FROM messages_fts WHERE message_id = old.id` は
    // message_id が UNINDEXED のため全文検索表を毎回全走査していた（6 万件で 1 件あたり約 2.7 秒）。
    // messages に FTS 行の rowid を控え、トリガーは rowid で消す（数ミリ秒）。
    if (currentDriver === 'sqlite') {
      const cols = await sql<{ name: string }>`PRAGMA table_info(messages)`.execute(db)
      if (!cols.rows.some((c) => c.name === 'fts_rowid'))
        await db.schema.alterTable('messages').addColumn('fts_rowid', 'integer').execute()
      await realignFtsRowids(db)
      await sql`DROP TRIGGER IF EXISTS messages_fts_ad`.execute(db)
      await sql`CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN DELETE FROM messages_fts WHERE rowid = old.fts_rowid; END`.execute(
        db,
      )
    } else {
      await db.schema.alterTable('messages').addColumn('fts_rowid', 'integer').execute()
    }
  },
  async down(db: Kysely<unknown>) {
    if (currentDriver === 'sqlite') {
      await sql`DROP TRIGGER IF EXISTS messages_fts_ad`.execute(db)
      await sql`CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN DELETE FROM messages_fts WHERE message_id = old.id; END`.execute(
        db,
      )
    }
    await db.schema.alterTable('messages').dropColumn('fts_rowid').execute()
  },
}

/**
 * messages.fts_rowid を messages_fts の rowid から埋め直し、対応するメールが無い FTS 行
 * （削除済み・重複）を消す。全文検索表の全走査を 2 回行うので、通常は移行時に一度だけ呼ぶ。
 */
export async function realignFtsRowids(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TEMP TABLE IF NOT EXISTS fts_rowid_map (message_id TEXT PRIMARY KEY, fts_rowid INTEGER NOT NULL)`.execute(
    db,
  )
  await sql`DELETE FROM fts_rowid_map`.execute(db)
  await sql`INSERT OR IGNORE INTO fts_rowid_map (message_id, fts_rowid) SELECT message_id, rowid FROM messages_fts`.execute(
    db,
  )
  await sql`UPDATE messages SET fts_rowid = (SELECT fts_rowid FROM fts_rowid_map WHERE fts_rowid_map.message_id = messages.id)`.execute(
    db,
  )
  await sql`DELETE FROM messages_fts WHERE rowid NOT IN (SELECT fts_rowid FROM messages WHERE fts_rowid IS NOT NULL)`.execute(
    db,
  )
  await sql`DROP TABLE IF EXISTS fts_rowid_map`.execute(db)
}

migrations['0010_account_groups'] = {
  async up(db: Kysely<unknown>) {
    // アカウントのグループ管理。accounts.group_id は任意で、グループ削除時は null に戻す。
    await db.schema
      .createTable('account_groups')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('name', 'text', (c) => c.notNull().unique())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addColumn('updated_at', 'text', (c) => c.notNull())
      .execute()
    await db.schema
      .alterTable('accounts')
      .addColumn('group_id', 'text', (c) => c.references('account_groups.id').onDelete('set null'))
      .execute()
    await db.schema.createIndex('idx_accounts_group').on('accounts').column('group_id').execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropIndex('idx_accounts_group').execute()
    await db.schema.alterTable('accounts').dropColumn('group_id').execute()
    await db.schema.dropTable('account_groups').execute()
  },
}

migrations['0011_forward_attempts'] = {
  async up(db: Kysely<unknown>) {
    // 転送失敗の記録。成功したら行を消す。自動転送は next_retry_at が過ぎたものだけ再試行する。
    await db.schema
      .createTable('forward_attempts')
      .addColumn('message_id', 'text', (c) =>
        c.notNull().references('messages.id').onDelete('cascade'),
      )
      .addColumn('to_address', 'text', (c) => c.notNull())
      .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(1))
      .addColumn('last_error', 'text')
      .addColumn('last_attempt_at', 'text', (c) => c.notNull())
      .addColumn('next_retry_at', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('pk_forward_attempts', ['message_id', 'to_address'])
      .execute()
    await db.schema
      .createIndex('idx_forward_attempts_next')
      .on('forward_attempts')
      .column('next_retry_at')
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('forward_attempts').execute()
  },
}

migrations['0012_forward_log'] = {
  async up(db: Kysely<unknown>) {
    // 転送済みの恒久ログ（messages に FK を持たない）。既存の forwards から可能な分を移す。
    await db.schema
      .createTable('forward_log')
      .addColumn('account_email', 'text', (c) => c.notNull())
      .addColumn('message_key', 'text', (c) => c.notNull())
      .addColumn('to_address', 'text', (c) => c.notNull())
      .addColumn('forwarded_at', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('pk_forward_log', ['account_email', 'message_key', 'to_address'])
      .execute()
    await sql`
      INSERT INTO forward_log (account_email, message_key, to_address, forwarded_at)
      SELECT lower(a.email), trim(m.message_id), lower(f.to_address), f.forwarded_at
      FROM forwards f
      JOIN messages m ON m.id = f.message_id
      JOIN accounts a ON a.id = m.account_id
      WHERE m.message_id IS NOT NULL AND trim(m.message_id) <> ''
      ON CONFLICT DO NOTHING
    `.execute(db)
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('forward_log').execute()
  },
}

migrations['0013_store_attachments_default'] = {
  async up(db: Kysely<unknown>) {
    // 転送を高速化するため、同期時に添付本体を保存する設定をこのアップグレードで ON にする。
    // （既定値の変更だけでは、以前に保存された 'false' が残るアプリで有効にならないため、明示的に上書きする。
    //  以後オフにしたい場合は設定画面で切り替えられる。）
    await sql`
      INSERT INTO settings (key, value) VALUES ('storeAttachments', '1')
      ON CONFLICT(key) DO UPDATE SET value = '1'
    `.execute(db)
  },
  async down() {
    // 追加した設定行は残す（ロールバックしない）。
  },
}

migrations['0014_account_health'] = {
  async up(db: Kysely<unknown>) {
    // 健全性モニタ用: 認証テスト・同期が「最終的に」失敗した連続回数（成功で 0 に戻る）
    await db.schema
      .alterTable('accounts')
      .addColumn('consecutive_failures', 'integer', (c) => c.notNull().defaultTo(0))
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.alterTable('accounts').dropColumn('consecutive_failures').execute()
  },
}

migrations['0015_mailbox_modseq'] = {
  async up(db: Kysely<unknown>) {
    // CONDSTORE 対応サーバーで、前回同期時の HIGHESTMODSEQ を控える（フラグ変更の差分取得用）。
    // 64bit 整数なので文字列で持つ。
    await db.schema.alterTable('mailboxes').addColumn('highest_modseq', 'text').execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.alterTable('mailboxes').dropColumn('highest_modseq').execute()
  },
}

migrations['0016_rule_actions'] = {
  async up(db: Kysely<unknown>) {
    // ルールのアクション種別（forward / mark_read / flag / move / delete / webhook）。
    // to_address はアクションの引数（転送先・移動先フォルダ・Webhook URL）として使う。
    await db.schema
      .alterTable('forward_rules')
      .addColumn('action', 'text', (c) => c.notNull().defaultTo('forward'))
      .execute()
    // 適用範囲のグループ（null = 全アカウント）
    await db.schema.alterTable('forward_rules').addColumn('group_id', 'text').execute()
    // 1 = ルール作成前に受信したメールにも適用する。既存の転送ルールは従来どおり全件が対象
    await db.schema
      .alterTable('forward_rules')
      .addColumn('apply_existing', 'integer', (c) => c.notNull().defaultTo(1))
      .execute()
    // 転送以外のアクションを同じメールへ繰り返し適用しないための記録
    await db.schema
      .createTable('rule_hits')
      .addColumn('rule_id', 'text', (c) =>
        c.notNull().references('forward_rules.id').onDelete('cascade'),
      )
      .addColumn('message_id', 'text', (c) =>
        c.notNull().references('messages.id').onDelete('cascade'),
      )
      .addColumn('applied_at', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('pk_rule_hits', ['rule_id', 'message_id'])
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('rule_hits').execute()
    await db.schema.alterTable('forward_rules').dropColumn('apply_existing').execute()
    await db.schema.alterTable('forward_rules').dropColumn('group_id').execute()
    await db.schema.alterTable('forward_rules').dropColumn('action').execute()
  },
}

migrations['0017_postgres_trigram_search'] = {
  async up(db: Kysely<unknown>) {
    // PostgreSQL の全文検索。SQLite の FTS5(trigram) に相当するものとして pg_trgm の GIN 索引を張る。
    // 検索は lower(列) LIKE '%語%' で行うので、索引の式は検索側（whereAnyColumnLike など）と完全に一致させる。
    // 拡張を作る権限が無い環境では索引なし（従来どおりの逐次走査）で動かす。
    if (currentDriver !== 'postgres') return
    try {
      await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db)
    } catch {
      return
    }
    const indexes: Array<[string, string, string]> = [
      ['idx_messages_subject_trgm2', 'messages', 'lower(subject)'],
      ['idx_messages_from_address_trgm', 'messages', "lower(coalesce(from_address, ''))"],
      ['idx_messages_from_name_trgm', 'messages', "lower(coalesce(from_name, ''))"],
      ['idx_messages_to_trgm', 'messages', 'lower(to_addresses)'],
      ['idx_messages_cc_trgm', 'messages', 'lower(cc_addresses)'],
      ['idx_messages_body_trgm', 'messages', "lower(coalesce(text_body, ''))"],
      ['idx_attachments_filename_trgm', 'attachments', 'lower(filename)'],
    ]
    for (const [name, table, expr] of indexes)
      await sql
        .raw(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} USING gin ((${expr}) gin_trgm_ops)`)
        .execute(db)
  },
  async down(db: Kysely<unknown>) {
    if (currentDriver !== 'postgres') return
    for (const name of [
      'idx_messages_subject_trgm2',
      'idx_messages_from_address_trgm',
      'idx_messages_from_name_trgm',
      'idx_messages_to_trgm',
      'idx_messages_cc_trgm',
      'idx_messages_body_trgm',
      'idx_attachments_filename_trgm',
    ])
      await sql.raw(`DROP INDEX IF EXISTS ${name}`).execute(db)
  },
}

migrations['0018_message_codes'] = {
  async up(db: Kysely<unknown>) {
    // 認証コード・確認リンクの抽出結果。otp_scanned = 0 の既存メールは起動後にバックグラウンドで抽出する
    await db.schema.alterTable('messages').addColumn('otp_code', 'text').execute()
    await db.schema.alterTable('messages').addColumn('otp_link', 'text').execute()
    await db.schema
      .alterTable('messages')
      .addColumn('otp_scanned', 'integer', (c) => c.notNull().defaultTo(0))
      .execute()
    await db.schema.createIndex('idx_messages_otp_scanned').on('messages').column('otp_scanned').execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropIndex('idx_messages_otp_scanned').execute()
    for (const c of ['otp_scanned', 'otp_link', 'otp_code'])
      await db.schema.alterTable('messages').dropColumn(c).execute()
  },
}

migrations['0019_mail_templates'] = {
  async up(db: Kysely<unknown>) {
    // 返信・新規送信で使う定型文。本文と件名に {{from_name}} などの差し込みが使える
    await db.schema
      .createTable('mail_templates')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('subject', 'text', (c) => c.notNull().defaultTo(''))
      .addColumn('body', 'text', (c) => c.notNull().defaultTo(''))
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addColumn('updated_at', 'text', (c) => c.notNull())
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('mail_templates').execute()
  },
}

migrations['0020_mail_op_history'] = {
  async up(db: Kysely<unknown>) {
    // 一括操作（削除・移動・既読・スター）の履歴。取り消し（元に戻す）に使う
    await db.schema
      .createTable('mail_ops')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('kind', 'text', (c) => c.notNull())
      .addColumn('source', 'text', (c) => c.notNull())
      .addColumn('rule_id', 'text')
      .addColumn('label', 'text')
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addColumn('undone_at', 'text')
      .execute()
    await db.schema.createIndex('idx_mail_ops_created').on('mail_ops').column('created_at').execute()
    await db.schema
      .createTable('mail_op_items')
      .addColumn('op_id', 'text', (c) => c.notNull().references('mail_ops.id').onDelete('cascade'))
      .addColumn('account_id', 'text', (c) => c.notNull())
      /** 操作したメールのローカル ID（フラグ操作の取り消しで DB も戻す）。削除・移動では行は残らない */
      .addColumn('message_id', 'text')
      .addColumn('subject', 'text', (c) => c.notNull().defaultTo(''))
      .addColumn('src_path', 'text', (c) => c.notNull())
      .addColumn('src_uid', 'integer', (c) => c.notNull())
      /** 移動・ゴミ箱への削除: 移動先フォルダと UID（UIDPLUS が無いと null で取り消せない） */
      .addColumn('dest_path', 'text')
      .addColumn('dest_uid', 'integer')
      .addColumn('prev_seen', 'integer')
      .addColumn('prev_flagged', 'integer')
      .execute()
    await db.schema.createIndex('idx_mail_op_items_op').on('mail_op_items').column('op_id').execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('mail_op_items').execute()
    await db.schema.dropTable('mail_ops').execute()
  },
}

migrations['0021_account_tags_notes'] = {
  async up(db: Kysely<unknown>) {
    // 複数タグ（JSON 配列の文字列）と自由記述のメモ。グループ（1 つだけ）とは別に整理に使う
    await db.schema
      .alterTable('accounts')
      .addColumn('tags', 'text', (c) => c.notNull().defaultTo('[]'))
      .execute()
    await db.schema.alterTable('accounts').addColumn('note', 'text').execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.alterTable('accounts').dropColumn('note').execute()
    await db.schema.alterTable('accounts').dropColumn('tags').execute()
  },
}

migrations['0022_audit_log'] = {
  async up(db: Kysely<unknown>) {
    // 監査ログ: 重要な操作（認証情報つき書き出し・削除・ルール変更など）を誰がいつ行ったか
    await db.schema
      .createTable('audit_log')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('at', 'text', (c) => c.notNull())
      .addColumn('actor', 'text', (c) => c.notNull())
      .addColumn('action', 'text', (c) => c.notNull())
      .addColumn('target', 'text')
      .addColumn('detail', 'text')
      .addColumn('ok', 'integer', (c) => c.notNull().defaultTo(1))
      .addColumn('error', 'text')
      .execute()
    await db.schema.createIndex('idx_audit_log_at').on('audit_log').column('at').execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('audit_log').execute()
  },
}

migrations['0023_api_fetch'] = {
  async up(db: Kysely<unknown>) {
    // 取得方法: imap（既定）/ graph（Microsoft Graph）/ gmail_api（Gmail API）
    await db.schema
      .alterTable('accounts')
      .addColumn('fetch_via', 'text', (c) => c.notNull().defaultTo('imap'))
      .execute()
    // API のメッセージ ID ↔ 同期処理で使う連番 UID（アカウントのメールアドレス・フォルダごと）
    await db.schema
      .createTable('api_uid_map')
      .addColumn('account_email', 'text', (c) => c.notNull())
      .addColumn('mailbox', 'text', (c) => c.notNull())
      .addColumn('remote_id', 'text', (c) => c.notNull())
      .addColumn('uid', 'integer', (c) => c.notNull())
      .addPrimaryKeyConstraint('pk_api_uid_map', ['account_email', 'mailbox', 'remote_id'])
      .execute()
    await db.schema
      .createIndex('idx_api_uid_map_uid')
      .on('api_uid_map')
      .columns(['account_email', 'mailbox', 'uid'])
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('api_uid_map').execute()
    await db.schema.alterTable('accounts').dropColumn('fetch_via').execute()
  },
}

const provider: MigrationProvider = {
  async getMigrations() {
    return migrations
  },
}

export async function migrateToLatest(db: Kysely<unknown>): Promise<void> {
  const migrator = new Migrator({ db, provider })
  const { error, results } = await migrator.migrateToLatest()
  if (error) {
    const failed = results?.find((r: { status: string }) => r.status === 'Error')
    throw new Error(
      `Migration failed${failed ? ` at ${failed.migrationName}` : ''}: ${String(error)}`,
    )
  }
}
