import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BackendEvent } from '@shared/api';
import type { JobInfo } from '@shared/types';
import { BackendApp, type BackendAppOptions } from '@backend/app';
import { CredentialCipher } from '@backend/security/credential-cipher';
import { createLogger, MemorySink } from '@backend/logging/logger';

export interface TestApp {
  app: BackendApp;
  logs: MemorySink;
  dir: string;
  dbFile: string;
  masterKey: Buffer;
  writeCsv(name: string, content: string): string;
  waitForJob(jobId: string, timeoutMs?: number): Promise<JobInfo>;
  cleanup(): Promise<void>;
}

export async function createTestApp(
  overrides: Partial<BackendAppOptions> & { env?: NodeJS.ProcessEnv; dbFile?: string } = {},
): Promise<TestApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-manager-test-'));
  const logs = new MemorySink();
  const masterKey = overrides.masterKey ?? CredentialCipher.generateKey();
  const dbFile = overrides.dbFile ?? path.join(dir, 'test.sqlite');
  const env: NodeJS.ProcessEnv = {
    MM_RETRY_DELAYS_MS: '10,20,30',
    MM_CONNECT_TIMEOUT_MS: '3000',
    // 既定では認証完了時の自動同期を無効化し、認証系テストの同時実行数を汚さない。
    // 自動同期を検証するテストは env で '1' を渡して上書きする。
    MM_AUTO_SYNC_ON_AUTH: '0',
    MM_STORE_ATTACHMENTS: '0',
    MM_AUTO_SYNC_INTERVAL_MIN: '0',
    MM_AUTO_SYNC_INTERVAL_SEC: '0',
    MM_STORAGE_SCHEDULE: '0',
    ...(overrides.env ?? {}),
  };
  const logger = createLogger({ level: 'debug', sinks: [logs], console: false });
  // env / dbFile / masterKey は上でマージ済みなので、残りの overrides だけを展開する
  // （そのまま ...overrides すると overrides.env がマージ済み env を上書きしてしまう）。
  const { env: _ignoredEnv, dbFile: _ignoredDbFile, masterKey: _ignoredKey, ...restOverrides } = overrides;
  const app = await BackendApp.create({
    userDataPath: dir,
    dbConfig: { driver: 'sqlite', file: dbFile },
    logger,
    keyMode: 'insecure-file',
    ...restOverrides,
    masterKey,
    env,
  });

  const jobWaiters = new Map<string, { resolve: (j: JobInfo) => void }>();
  app.onEvent((ev: BackendEvent) => {
    if (ev.type === 'job.updated' && ev.job.status !== 'running') {
      jobWaiters.get(ev.job.id)?.resolve(ev.job);
    }
  });

  return {
    app,
    logs,
    dir,
    dbFile,
    masterKey,
    writeCsv(name, content) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, content, 'utf8');
      return p;
    },
    async waitForJob(jobId, timeoutMs = 60_000) {
      const existing = app.authTest.listJobs().find((j) => j.id === jobId);
      if (existing && existing.status !== 'running') return existing;
      const job = await new Promise<JobInfo>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`job ${jobId} did not finish in ${timeoutMs}ms`)),
          timeoutMs,
        );
        jobWaiters.set(jobId, {
          resolve: (j) => {
            clearTimeout(timer);
            resolve(j);
          },
        });
      });
      await app.authTest.flushEvents();
      return job;
    },
    async cleanup() {
      await app.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
