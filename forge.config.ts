import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerDeb } from '@electron-forge/maker-deb';
import { PublisherGithub } from '@electron-forge/publisher-github';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

// MM_E2E_BUILD=1 のときだけ Playwright が必要とする inspect 系の fuse を開ける。
const e2eBuild = process.env.MM_E2E_BUILD === '1';

// macOS の署名・公証は、証明書と Apple ID の情報が環境変数で渡されたときだけ行う（CI の secrets から渡す）。
//   APPLE_SIGN_IDENTITY: "Developer ID Application: Your Name (TEAMID)"
//   APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID: 公証（notarytool）用
const env = process.env;
const signMac = !!env.APPLE_SIGN_IDENTITY && !e2eBuild;
const notarizeMac = signMac && !!env.APPLE_ID && !!env.APPLE_APP_SPECIFIC_PASSWORD && !!env.APPLE_TEAM_ID;

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'Mail Manager',
    executableName: 'Mail Manager',
    appBundleId: 'app.mailmanager.desktop',
    appCategoryType: 'public.app-category.productivity',
    // `npm run make -- --arch=universal` で Universal macOS Build を生成する。
    osxUniversal: {},
    ...(signMac ? { osxSign: { identity: env.APPLE_SIGN_IDENTITY } } : {}),
    ...(notarizeMac
      ? {
          osxNotarize: {
            appleId: env.APPLE_ID!,
            appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD!,
            teamId: env.APPLE_TEAM_ID!,
          },
        }
      : {}),
  },
  rebuildConfig: {},
  makers: [
    // macOS: 自動アップデートは ZIP を使う（update.electronjs.org の要件）。配布用に DMG も作る
    new MakerZIP({}, ['darwin', 'linux']),
    new MakerDMG({ format: 'ULFO' }, ['darwin']),
    // Windows: Squirrel インストーラー（自動アップデートに対応）
    new MakerSquirrel({ name: 'MailManager', setupExe: 'MailManagerSetup.exe' }),
    // Linux: .deb（自動アップデートは非対応。ZIP も作る）
    new MakerDeb({ options: { name: 'mail-manager', productName: 'Mail Manager', categories: ['Network', 'Office'] } }),
  ],
  publishers: [
    // `npm run publish` で GitHub Releases に下書きとしてアップロードする（GITHUB_TOKEN が必要）
    new PublisherGithub({
      repository: { owner: 'ANFINII', name: 'mail-manager' },
      draft: true,
      prerelease: false,
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
        // backend は utilityProcess で動く別プロセス。main と同じ Node ターゲットでビルドする。
        { entry: 'src/backend/backend.ts', config: 'vite.backend.config.ts', target: 'main' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: e2eBuild,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: e2eBuild,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
