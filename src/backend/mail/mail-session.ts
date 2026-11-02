import type { MessageEnvelopeObject, MessageStructureObject } from 'imapflow'
import type { ConnectionTestParams } from './email-provider'

export type SessionParams = ConnectionTestParams;

export interface MailboxInfo {
  path: string;
  name: string;
  delimiter: string | null;
  specialUse: string | null;
  noselect: boolean;
}

export interface OpenedMailbox {
  path: string;
  uidValidity: number;
  uidNext: number;
  exists: number;
  /** CONDSTORE 対応時の HIGHESTMODSEQ（10 進文字列）。非対応なら null */
  highestModseq: string | null;
}

export interface FlagState {
  uid: number;
  flags: Set<string>;
}

export interface FetchedMessage {
  uid: number;
  flags: Set<string>;
  size: number;
  internalDate: string | null;
  envelope?: MessageEnvelopeObject;
  bodyStructure?: MessageStructureObject;
  source?: Buffer;
}

export interface DownloadedPart {
  content: Buffer;
  contentType: string;
  charset?: string;
  filename?: string;
}

/**
 * 認証済みの IMAP セッション。同期・フラグ操作・添付取得で使う。
 * ImapFlow 実装のほかに、テスト用や他プロトコル（Graph API 等）の実装に差し替えられる。
 */
export interface MailSession {
  listMailboxes(): Promise<MailboxInfo[]>;
  openMailbox(path: string, readOnly: boolean): Promise<OpenedMailbox>;
  /** 指定 UID 以上のメッセージ UID を昇順で返す */
  searchUidsFrom(uid: number): Promise<number[]>;
  fetch(
    uids: number[],
    opts: { source: boolean; structure: boolean },
  ): AsyncIterable<FetchedMessage>;
  /**
   * UID 範囲 [fromUid, toUid] のフラグだけを取得する。
   * changedSince（CONDSTORE の MODSEQ）を渡すと、それ以降に変わったメッセージだけを返す。
   */
  fetchFlags(fromUid: number, toUid: number, changedSince?: string | null): AsyncIterable<FlagState>;
  downloadPart(uid: number, part: string, maxBytes?: number): Promise<DownloadedPart>;
  addFlags(uids: number[], flags: string[]): Promise<void>;
  removeFlags(uids: number[], flags: string[]): Promise<void>;
  moveTo(uids: number[], destination: string): Promise<void>;
  deleteMessages(uids: number[]): Promise<void>;
  /** Sent などのフォルダに raw メッセージを保存する。UID を返す（UIDPLUS 対応時） */
  append(path: string, raw: Buffer, flags: string[]): Promise<number | null>;
  /**
   * 開いているフォルダで IMAP IDLE し、新着（EXISTS の増加）を待つ。
   * 新着で 'new'、maxMs 経過で 'timeout' を返す。サーバーが IDLE 非対応なら 'unsupported'。
   * 接続が切れたら例外。signal で中断できる。
   */
  waitForNewMail(maxMs: number, signal: AbortSignal): Promise<'new' | 'timeout' | 'unsupported'>;
  close(): Promise<void>;
}
