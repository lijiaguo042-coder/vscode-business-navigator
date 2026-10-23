import fs from 'node:fs/promises';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { parse as parseJson } from 'jsonc-parser';
import { IndexOptions, defaults } from './types';

/** 判断路径是否仍在当前工作区内。 */
function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
/** 收集源码快照；跳过符号链接和依赖，未保存文档覆盖磁盘内容。 */
export async function collectSources(root: string, options: IndexOptions, overlays = new Map<string, string>()): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const excluded = [...new Set([...defaults.exclude, ...options.exclude])];
  const roots = new Set(options.sourceRoots.map(p => path.resolve(root, p)));
  const entrypoints = options.routeEntrypoints.map(p => path.resolve(root, p));
  const seen = new Set<string>();
  /** 检查 glob 时同时匹配目录本身和其子项，避免遍历排除目录。 */
  function ignored(file: string): boolean {
    const relative = path.relative(root, file).split(path.sep).join('/');
    return !inside(root, file) || excluded.some(pattern => minimatch(relative, pattern, { dot: true }) || minimatch(relative + '/', pattern, { dot: true }));
  }
  /** 有界串行遍历目录，避免同时打开大量文件。 */
  async function visit(file: string, metadata = false): Promise<void> {
    if (seen.has(file) || ignored(file)) return;
    seen.add(file);
    let stat;
    try { stat = await fs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const child of await fs.readdir(file)) await visit(path.join(file, child));
    } else if (metadata || /\.(php|js|vue)$/.test(file)) {
      files.set(file, overlays.get(file) ?? await fs.readFile(file, 'utf8'));
    }
  }
  for (const config of ['composer.json', 'jsconfig.json']) await visit(path.join(root, config), true);
  const composer = parseJson(files.get(path.join(root, 'composer.json')) ?? '{}');
  for (const target of Object.values(composer?.autoload?.['psr-4'] ?? {})) {
    for (const directory of Array.isArray(target) ? target : [target]) if (typeof directory === 'string') roots.add(path.resolve(root, directory));
  }
  for (const entrypoint of entrypoints) await visit(entrypoint);
  for (const directory of roots) await visit(directory);
  for (const [file, text] of overlays) if (!ignored(file) && (files.has(file) || [...roots].some(r => inside(r, file))) && /\.(php|js|vue)$/.test(file)) files.set(file, text);
  return files;
}
