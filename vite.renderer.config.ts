import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { rendererAlias } from './vite.shared';

const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";
// 開発時は Vite / React Refresh のインラインスクリプトと HMR の WebSocket を許可する
const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*";

const csp: Plugin = {
  name: 'mail-manager-csp',
  transformIndexHtml(html, ctx) {
    const content = ctx.server ? DEV_CSP : PROD_CSP;
    return html.replace(
      '<!--CSP-->',
      `<meta http-equiv="Content-Security-Policy" content="${content}" />`,
    );
  },
};

export default defineConfig({
  plugins: [react(), csp],
  resolve: { alias: rendererAlias },
  build: { sourcemap: true },
});
