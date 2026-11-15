// AgentCore Runtime（NODE_22 直接コードデプロイ）用に、エージェントを 1 ファイルにバンドルする。
// 依存（AWS SDK など）も含めるので、zip には node_modules が不要になる。
import { build } from 'esbuild';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';

const outdir = 'dist/agent';
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: ['src/agent/main.ts'],
  outfile: `${outdir}/main.js`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true, // main.js.map（NODE_OPTIONS=--enable-source-maps で利用）
  legalComments: 'none',
  logLevel: 'warning',
});
// プロジェクト直下の "type": "module" の影響を受けないようにする
await writeFile(`${outdir}/package.json`, JSON.stringify({ type: 'commonjs' }) + '\n');
// AgentCore Runtime は POSIX のファイル権限を見るため、読み取り可能にしておく
await chmod(`${outdir}/main.js`, 0o644);
console.error(`[build-agent] bundled -> ${outdir}/main.js`);
