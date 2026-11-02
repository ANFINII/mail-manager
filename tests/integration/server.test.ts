import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { toCsv } from '../helpers/csv-fixtures';
import { createMailServer, parseTokens } from '../../src/server/http-server';
import { RemoteHost } from '../../src/main/remote-host';
import type { BackendEvent } from '@shared/api';

let t: TestApp;
let server: http.Server;
let url: string;
const ALICE = 'alice-token-0123456789';

beforeEach(async () => {
  t = await createTestApp();
  server = createMailServer({ app: t.app, tokens: parseTokens(`alice:${ALICE},bob:bob-token-0123456789`), tmpDir: path.join(t.dir, 'srv-tmp') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await t.cleanup();
});

const csv = () =>
  toCsv([
    { email: 'a@example.com', provider: 'custom', auth_type: 'password', password: 'pw-a', imap_host: 'h', imap_port: '993', imap_secure: 'tls' },
    { email: 'b@example.com', provider: 'custom', auth_type: 'password', password: 'pw-b', imap_host: 'h', imap_port: '993', imap_secure: 'tls' },
  ]);

describe('shared server', () => {
  it('rejects bad tokens and weak tokens', async () => {
    expect(() => parseTokens('x:short')).toThrow(/16/);
    const bad = new RemoteHost({ url, token: 'wrong-token-0123456789', cacheDir: t.dir });
    await expect(bad.call('accounts.list', {})).rejects.toThrow(/認証/);
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });

  it('runs RPCs from a remote client, moving files between the client and the server', async () => {
    const remote = new RemoteHost({ url, token: ALICE, cacheDir: path.join(t.dir, 'client-cache') });
    const events: BackendEvent[] = [];
    remote.onEvent((e) => events.push(e));
    remote.start();
    await new Promise((r) => setTimeout(r, 100));

    // 端末側のファイルを取り込む（サーバーにはそのパスは無い）
    const local = path.join(t.dir, 'client', 'accounts.csv');
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, csv());
    const r = (await remote.call('accounts.importCsv', { path: local })) as { imported: number };
    expect(r.imported).toBe(2);
    expect(((await remote.call('accounts.list', {})) as unknown[]).length).toBe(2);

    // 書き出しは端末側のパスに書かれる
    const out = path.join(t.dir, 'client', 'out', 'creds.csv');
    expect(await remote.call('accounts.exportCsvWithCredentials', { path: out })).toEqual({ count: 2 });
    expect(fs.readFileSync(out, 'utf8')).toContain('pw-a');
    // サーバーの一時ファイルは残らない
    expect(fs.readdirSync(path.join(t.dir, 'srv-tmp'))).toEqual([]);

    // イベントも届く
    for (let i = 0; i < 50 && !events.some((e) => e.type === 'accounts.imported'); i++) await new Promise((res) => setTimeout(res, 20));
    expect(events.some((e) => e.type === 'accounts.imported')).toBe(true);

    // 監査ログの操作者はトークンの名前
    const audit = (await remote.call('audit.list', {})) as Array<{ action: string; actor: string }>;
    expect(audit.find((a) => a.action === 'accounts.exportCsvWithCredentials')?.actor).toBe('alice');

    // エラーはそのまま伝わる
    await expect(remote.call('forwardRules.add', { keyword: 'x', matchField: 'subject', to: 'bad', enabled: true })).rejects.toThrow(/転送先/);
    remote.stop();
  });
});
