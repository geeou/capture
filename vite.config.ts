import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/** Emits dist/sw.js with the list of built files, so the PWA is fully available offline after the first visit. */
function serviceWorker(): Plugin {
  return {
    name: 'capture-sw',
    apply: 'build',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const built = Object.keys(bundle).filter(f => !f.endsWith('.map') && !f.endsWith('.woff') && f !== 'index.html');
      const statics = ['manifest.webmanifest', ...readdirSync('public/icons').map(f => 'icons/' + f)];
      const files = ['./', ...built, ...statics];
      const version = createHash('sha1').update(files.join('|')).digest('hex').slice(0, 10);
      const source = readFileSync('pwa/sw.template.js', 'utf8')
        .replace('__VERSION__', version)
        .replace('__FILES__', JSON.stringify(files));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

// base './' so the same build works on GitHub Pages (/<repo>/) and on any other host
export default defineConfig({
  base: './',
  server: { port: 5266, strictPort: true },
  build: { target: 'es2022' },
  plugins: [serviceWorker()],
});
