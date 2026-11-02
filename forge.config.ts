import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

// MM_E2E_BUILD=1 のときだけ Playwright が必要とする inspect 系の fuse を開ける。
const e2eBuild = process.env.MM_E2E_BUILD === '1';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'Mail Manager',
    executableName: 'Mail Manager',
    appBundleId: 'app.mailmanager.desktop',
    appCategoryType: 'public.app-category.productivity',
    // `npm run make -- --arch=universal` で Universal macOS Build を生成する。
    osxUniversal: {},
  },
  rebuildConfig: {},
  makers: [new MakerZIP({}, ['darwin']), new MakerDMG({ format: 'ULFO' }, ['darwin'])],
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
