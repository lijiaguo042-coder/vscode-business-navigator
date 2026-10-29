/** 使用 UTF-16 字符偏移保存源码范围，与 VS Code positionAt 一致。 */
export interface Span { file: string; start: number; end: number }
export type NodeKind = 'page' | 'api' | 'route' | 'controller' | 'service' | 'config' | 'unresolved';
export interface CodeNode extends Span { id: string; kind: NodeKind; label: string; detail?: string }
export interface Edge { from: string; to: string; site: Span }
export interface RouteRecord { node: CodeNode; methods: string[]; path: string; controller?: string; action?: string; handler?: Span }
export interface PhpMethod { node: CodeNode; className: string; name: string; calls: { className?: string; method: string; site: Span; reason?: string }[] }
export interface PhpResult { routes: RouteRecord[]; methods: PhpMethod[]; configs: { node: CodeNode; site: Span }[]; errors: { file: string; message: string }[] }
export interface Endpoint { node: CodeNode; method: string; path?: string; urlSite: Span }
export interface FrontendResult { nodes: CodeNode[]; edges: Edge[]; endpoints: Endpoint[]; errors: { file: string; message: string }[] }
export interface IndexOptions {
  sourceRoots: string[]; routeEntrypoints: string[]; requestModules: string[];
  requestBasePath: string; exclude: string[];
}
export const defaults: IndexOptions = {
  sourceRoots: ['resources/js', 'app', 'routes', 'config'],
  routeEntrypoints: ['app/Providers/RouteServiceProvider.php'],
  requestModules: ['resources/js/utils/request.js'], requestBasePath: '/api',
  exclude: ['**/vendor/**', '**/node_modules/**', '**/public/**', '**/storage/**', '**/.git/**', '**/tools/vscode-business-navigator/**'],
};
/** 为同一源码节点产生稳定、工作区内唯一的标识。 */
export function nodeId(file: string, start: number, tag: string): string { return `${file}:${start}:${tag}`; }
