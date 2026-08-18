// 从矢量母版生成 Tauri 各平台图标。
// 运行：node gen-icon.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./icon-source.svg', import.meta.url));
const output = fileURLToPath(new URL('.', import.meta.url));
const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const result = spawnSync(cargo, ['tauri', 'icon', source, '-o', output], {
  stdio: 'inherit'
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
