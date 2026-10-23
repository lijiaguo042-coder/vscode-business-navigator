import { parentPort, workerData } from 'node:worker_threads';
import { buildIndex } from './index';
// Worker 独立解析快照，避免阻塞 VS Code 扩展宿主。
try {
  const graph = buildIndex(new Map(workerData.files), workerData.root, workerData.options);
  parentPort?.postMessage({ nodes: [...graph.nodes.values()], edges: graph.edges, errors: graph.errors });
} catch {
  parentPort?.postMessage({ error: '建立索引失败，请检查插件配置和源码语法。' });
}
