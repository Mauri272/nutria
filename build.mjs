// Empaqueta la PWA: TS → un solo JS (esbuild) + CSS inline → dist/index.html; copia manifest, sw e íconos.
import { build } from '/opt/npm-tools/node_modules/esbuild/lib/main.js';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const out = await build({ entryPoints: [join(root, 'src/main.ts')], bundle: true, format: 'iife', target: 'es2022', minify: true, write: false, legalComments: 'none' });
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = readFileSync(join(root, 'src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
const html = readFileSync(join(root, 'src/index.template.html'), 'utf8').replace('/*CSS*/', () => css).replace('/*JS*/', () => js);
writeFileSync(join(dist, 'index.html'), html);
const stamp = Date.now().toString(36);
writeFileSync(join(dist, 'sw.js'), readFileSync(join(root, 'public/sw.js'), 'utf8').replace('__BUILD__', stamp));
for (const f of ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) cpSync(join(root, 'public', f), join(dist, f));
writeFileSync(join(dist, '.nojekyll'), '');
console.log(`dist/index.html ${(html.length / 1024).toFixed(0)} KB (build ${stamp})`);
