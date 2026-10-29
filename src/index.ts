import path from 'node:path';
import { analyzeFrontend } from './frontend';
import { analyzePhp } from './php';
import { CodeNode, Edge, IndexOptions, Span, nodeId } from './types';

/** 判断光标是否位于有效源码范围，零长度结构边不参与跳转。 */
function contains(span: Span, file: string, offset: number): boolean {
  return span.file === file && span.end > span.start && offset >= span.start && offset < span.end;
}
/** 将本地相对或斜杠开头的请求拼接到基础路径，排除协议和外部地址。 */
function requestPath(url: string, base: string): string | undefined {
  if (!url || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) return undefined;
  const basePath = /^https?:\/\//.test(base) ? new URL(base).pathname : base;
  return ('/' + basePath.replace(/^\/+|\/+$/g, '') + '/' + url.replace(/^\/+/, '')).replace(/\/+/g, '/').split(/[?#]/)[0].replace(/\/$/, '') || '/';
}
/** 按路径段匹配动态参数，Laravel 可选参数同时支持缺省段。 */
function matches(url: string, route: string): boolean {
  const a = url.split('/').filter(Boolean), b = route.split('/').filter(Boolean);
  if (a.length > b.length) return false;
  return b.every((segment, i) => {
    if (a[i] === undefined) return /^\{[^}]+\?\}$/.test(segment);
    return /^\{[^}]+\}$/.test(segment) || /^\{[^}]+\}$/.test(a[i]) || segment === a[i];
  });
}
/** 同一索引提供定义跳转、反向引用和双向侧栏关系。 */
export class NavigationIndex {
  readonly nodes = new Map<string, CodeNode>();
  readonly edges: Edge[] = [];
  readonly errors: { file: string; message: string }[] = [];
  private readonly forward = new Map<string, Edge[]>();
  private readonly backward = new Map<string, Edge[]>();

  /** 建立邻接表，保留多候选但去除重复源码关联。 */
  constructor(nodes: CodeNode[], edges: Edge[], errors: { file: string; message: string }[]) {
    nodes.forEach(n => this.nodes.set(n.id, n)); this.errors = errors;
    const seen = new Set<string>();
    for (const edge of edges) {
      const key = [edge.from, edge.to, edge.site.file, edge.site.start, edge.site.end].join('|');
      if (seen.has(key) || !this.nodes.has(edge.from) || !this.nodes.has(edge.to)) continue;
      seen.add(key); this.edges.push(edge);
      const out = this.forward.get(edge.from) ?? []; out.push(edge); this.forward.set(edge.from, out);
      const incoming = this.backward.get(edge.to) ?? []; incoming.push(edge); this.backward.set(edge.to, incoming);
    }
  }
  /** 选择最内层方法或 URL 所属节点。 */
  nodeAt(file: string, offset: number): CodeNode | undefined {
    const sites = this.edges.filter(e => contains(e.site, file, offset)).sort((a, b) => (a.site.end - a.site.start) - (b.site.end - b.site.start));
    if (sites.length) return this.nodes.get(sites[0].from);
    return [...this.nodes.values()].filter(n => contains(n, file, offset)).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
  }
  /** 返回源码位置的确定目标；API URL 默认定位路由，可按设置直达控制器。 */
  definitions(file: string, offset: number, apiTarget: 'route' | 'controller' = 'route'): CodeNode[] {
    const edges = this.edges.filter(e => contains(e.site, file, offset));
    const output = new Map<string, CodeNode>();
    for (const edge of edges) {
      const node = this.nodes.get(edge.to)!;
      const targets = node.kind === 'route' && apiTarget === 'controller' ? this.outgoing(node.id).filter(n => n.kind === 'controller') : [node];
      for (const target of targets) if (target.kind !== 'unresolved') output.set(`${target.file}:${target.start}`, target);
    }
    return [...output.values()];
  }
  /** 展示一个节点的直接下游。 */
  outgoing(id: string): CodeNode[] { return [...new Set((this.forward.get(id) ?? []).map(e => e.to))].map(key => this.nodes.get(key)!); }
  /** 展示一个节点的直接上游。 */
  incoming(id: string): CodeNode[] { return [...new Set((this.backward.get(id) ?? []).map(e => e.from))].map(key => this.nodes.get(key)!); }
  /** 沿反向业务关联收集真实调用位置，排除文件分组用的结构边。 */
  references(id: string): Span[] {
    const seen = new Set<string>(), locations = new Map<string, Span>(), queue = [id];
    while (queue.length) {
      const current = queue.shift()!; if (seen.has(current)) continue; seen.add(current);
      for (const edge of this.backward.get(current) ?? []) {
        if (edge.site.end > edge.site.start) locations.set(`${edge.site.file}:${edge.site.start}:${edge.site.end}`, edge.site);
        queue.push(edge.from);
      }
    }
    return [...locations.values()];
  }
}
/** 纯静态建立跨语言关联，不执行工作区代码。 */
export function buildIndex(files: Map<string, string>, root: string, options: IndexOptions): NavigationIndex {
  const frontend = analyzeFrontend(files, root, options);
  const php = analyzePhp(files, root, options.routeEntrypoints);
  const nodes = [...frontend.nodes, ...php.routes.map(r => r.node), ...php.methods.map(m => m.node), ...php.configs.map(c => c.node)];
  const edges = [...frontend.edges];
  const phpFiles = new Map<string, CodeNode>();
  for (const config of php.configs) {
    let owner: CodeNode | undefined = php.methods.filter(method => contains(method.node, config.site.file, config.site.start)).sort((a, b) => (a.node.end - a.node.start) - (b.node.end - b.node.start))[0]?.node;
    if (!owner) {
      owner = phpFiles.get(config.site.file);
      if (!owner) {
        owner = { file: config.site.file, start: 0, end: files.get(config.site.file)?.length ?? 0, id: nodeId(config.site.file, 0, 'php-file'), kind: 'page', label: path.basename(config.site.file) };
        phpFiles.set(config.site.file, owner); nodes.push(owner);
      }
    }
    edges.push({ from: owner.id, to: config.node.id, site: config.site });
  }
  const methods = new Map(php.methods.map(m => [`${m.className.toLowerCase()}::${m.name.toLowerCase()}`, m]));
  for (const route of php.routes) {
    const method = methods.get(`${route.controller?.toLowerCase()}::${route.action?.toLowerCase()}`);
    if (method) edges.push({ from: route.node.id, to: method.node.id, site: route.handler ?? route.node });
    else {
      const unresolved: CodeNode = { ...route.node, id: route.node.id + ':missing', kind: 'unresolved', label: '未解析控制器', detail: '控制器方法未在静态源码中找到' };
      nodes.push(unresolved); edges.push({ from: route.node.id, to: unresolved.id, site: { ...route.node, end: route.node.start } });
    }
  }
  for (const endpoint of frontend.endpoints) {
    const url = endpoint.path && requestPath(endpoint.path, options.requestBasePath);
    const candidates = url ? php.routes.filter(r => r.methods.includes(endpoint.method) && matches(url, r.path)) : [];
    for (const route of candidates) edges.push({ from: endpoint.node.id, to: route.node.id, site: endpoint.urlSite });
    if (!candidates.length) {
      const unresolved: CodeNode = { ...endpoint.urlSite, id: nodeId(endpoint.urlSite.file, endpoint.urlSite.start, 'unresolved:' + endpoint.node.id), kind: 'unresolved', label: url ? `未匹配路由：${endpoint.method} ${url}` : '未解析动态请求', detail: '请检查静态表达式、请求基础路径及路由入口配置' };
      nodes.push(unresolved); edges.push({ from: endpoint.node.id, to: unresolved.id, site: endpoint.urlSite });
    }
  }
  for (const method of php.methods) {
    // 每个应用方法只记录直接调用，逐层浏览与循环停止由关系图和侧栏处理。
    for (const call of method.calls) {
      const target = call.className && methods.get(`${call.className.toLowerCase()}::${call.method.toLowerCase()}`);
      if (target) edges.push({ from: method.node.id, to: target.node.id, site: call.site });
      else {
        const unresolved: CodeNode = { ...call.site, id: nodeId(call.site.file, call.site.start, 'call:' + call.method), kind: 'unresolved', label: `未解析：${call.method}`, detail: call.reason ?? '未找到明确类型的目标方法，可能属于框架、Facade 或动态绑定' };
        nodes.push(unresolved); edges.push({ from: method.node.id, to: unresolved.id, site: call.site });
      }
    }
  }
  return new NavigationIndex(nodes, edges, [...frontend.errors, ...php.errors]);
}
