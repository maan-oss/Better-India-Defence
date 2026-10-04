import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const banner = { js: "import{createRequire as __strataCreateRequire}from'module';const require=__strataCreateRequire(import.meta.url);" };
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: true, banner, external: ['@electric-sql/pglite', 'pg-native', 'pino-pretty', 'onnxruntime-node'] };
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.js' });
await build({ ...common, entryPoints: ['src/reconstruction/worker.ts'], outfile: 'dist/worker.js' });
await build({ ...common, entryPoints: ['src/vision/worker.ts'], outfile: 'dist/visionWorker.js' });
await build({ ...common, entryPoints: ['src/seed.ts'], outfile: 'dist/seed.js' });
mkdirSync('dist/migrations', { recursive: true });
cpSync('src/db/migrations', 'dist/migrations', { recursive: true });
console.log('server build complete');
