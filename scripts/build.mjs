import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
await rm(new URL('../build/', import.meta.url), { recursive: true, force: true });
for (const config of ['tsconfig.main.json', 'tsconfig.renderer.json']) {
  execFileSync(process.execPath, [compiler, '-p', config], { cwd: root, stdio: 'inherit' });
}
await mkdir(new URL('../build/renderer/', import.meta.url), { recursive: true });
for (const asset of ['index.html', 'styles.css']) {
  await copyFile(
    new URL(`../src/renderer/${asset}`, import.meta.url),
    new URL(`../build/renderer/${asset}`, import.meta.url),
  );
}
