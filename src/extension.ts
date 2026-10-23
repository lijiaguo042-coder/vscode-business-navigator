import * as vscode from 'vscode';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { Worker } from 'node:worker_threads';
import { NavigationIndex } from './index';
import { collectSources } from './workspace';
import { CodeNode, IndexOptions, Span, defaults } from './types';
interface State {
  folder: vscode.WorkspaceFolder; graph?: NavigationIndex; files: Map<string, string>;
  revision: number; dirty: boolean; pending?: Promise<void>; timer?: NodeJS.Timeout; worker?: Worker; status: string;
}
interface Item { label?: string; node?: CodeNode; state?: State; direction?: 'in' | 'out'; trail?: string[]; group?: boolean }

/** 将快照中的 UTF-16 偏移转换为编辑器位置。 */
function position(text: string, offset: number): vscode.Position {
  const before = text.slice(0, offset).split('\n');
  return new vscode.Position(before.length - 1, before[before.length - 1].length);
}
/** 扩展宿主中的工作区缓存和后台解析调度。 */
class IndexManager implements vscode.Disposable {
  readonly states = new Map<string, State>();
  private disposed = false;
  /** 共享输出和刷新通知，所有工作区使用独立状态。 */
  constructor(private context: vscode.ExtensionContext, private output: vscode.OutputChannel, private changed: () => void) {}
  /** 获取文件对应工作区，不对非本地文件运行扫描。 */
  state(uri: vscode.Uri): State | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || folder.uri.scheme !== 'file') return undefined;
    let state = this.states.get(folder.uri.toString());
    if (!state) {
      state = { folder, files: new Map(), revision: 0, dirty: true, status: '尚未建立索引' };
      this.states.set(folder.uri.toString(), state);
    }
    return state;
  }
  /** 读取当前工作区配置，默认约定适配本项目。 */
  options(state: State): IndexOptions {
    const config = vscode.workspace.getConfiguration('businessNavigator', state.folder.uri);
    return {
      sourceRoots: config.get('sourceRoots', defaults.sourceRoots),
      routeEntrypoints: config.get('routeEntrypoints', defaults.routeEntrypoints),
      requestModules: config.get('requestModules', defaults.requestModules),
      requestBasePath: config.get('requestBasePath', defaults.requestBasePath),
      exclude: config.get('exclude', defaults.exclude),
    };
  }
  /** 失效后防抖重建；尚未使用的工作区不主动索引。 */
  invalidate(uri?: vscode.Uri): void {
    const states = [...this.states.values()].filter(state => {
      if (!uri) return true;
      const relative = path.relative(state.folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
      if (uri.scheme !== 'file' || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return false;
      return ![...defaults.exclude, ...this.options(state).exclude].some(pattern => minimatch(relative, pattern, { dot: true }));
    });
    for (const state of states) {
      state.dirty = true; state.revision++;
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => { void this.ensure(state).catch(() => {}); }, 400);
    }
  }
  /** 在 Worker 中解析快照，只接受最新版本，失败时清除旧跳转避免误导。 */
  async ensure(state: State): Promise<NavigationIndex> {
    if (this.disposed) throw new Error('插件已关闭');
    if (state.pending) { await state.pending; return this.ensure(state); }
    if (!state.dirty && state.graph) return state.graph;
    const revision = state.revision;
    state.dirty = false; state.status = '正在建立索引…'; this.changed();
    state.pending = (async () => {
      try {
        const options = this.options(state);
        const overlays = new Map(vscode.workspace.textDocuments.filter(d => d.uri.scheme === 'file' && !d.isUntitled && d.isDirty).map(d => [d.uri.fsPath, d.getText()]));
        const files = await collectSources(state.folder.uri.fsPath, options, overlays);
        if (this.disposed) return;
        const payload = await new Promise<any>((resolve, reject) => {
          const worker = new Worker(this.context.asAbsolutePath('dist/worker.js'), { workerData: { files: [...files], root: state.folder.uri.fsPath, options } });
          state.worker = worker;
          worker.once('message', resolve);
          worker.once('error', () => reject(new Error('解析进程失败')));
          worker.once('exit', () => reject(new Error('解析进程未返回索引')));
        });
        state.worker = undefined;
        if (this.disposed || revision !== state.revision) { state.dirty = true; return; }
        if (payload.error) throw new Error(payload.error);
        state.files = files; state.graph = new NavigationIndex(payload.nodes, payload.edges, payload.errors);
        state.status = `${state.graph.nodes.size} 个节点 · ${state.graph.errors.length} 个文件诊断`;
        for (const error of state.graph.errors) this.output.appendLine(`${path.relative(state.folder.uri.fsPath, error.file)}: ${error.message}`);
      } catch {
        state.graph = new NavigationIndex([], [], []);
        state.status = '索引失败，请检查目录配置和读取权限';
        this.output.appendLine(`${state.folder.name}: ${state.status}`);
      } finally { this.changed(); }
    })();
    await state.pending; state.pending = undefined;
    return this.ensure(state);
  }
  /** 用索引快照创建可点击位置，避免加载业务模块。 */
  location(state: State, span: Span): vscode.Location {
    const text = state.files.get(span.file) ?? '';
    return new vscode.Location(vscode.Uri.file(span.file), new vscode.Range(position(text, span.start), position(text, span.end)));
  }
  /** 工作区移除或插件退出时清理计时器与 Worker。 */
  dispose(): void {
    this.disposed = true;
    for (const state of this.states.values()) { if (state.timer) clearTimeout(state.timer); void state.worker?.terminate(); }
    this.states.clear();
  }
  /** 移除已关闭工作区的缓存，保留仍在使用的工作区。 */
  prune(): void {
    const keys = new Set(vscode.workspace.workspaceFolders?.map(f => f.uri.toString()) ?? []);
    for (const [key, state] of this.states) if (!keys.has(key)) {
      if (state.timer) clearTimeout(state.timer); void state.worker?.terminate(); this.states.delete(key);
    }
  }
}

/** 原生侧栏展示当前入口及其上下游，每条分支使用独立循环检测。 */
class ChainTree implements vscode.TreeDataProvider<Item>, vscode.Disposable {
  readonly emitter = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  pinned?: { state: State; node: CodeNode };
  private manager!: IndexManager;
  /** 绑定索引管理器以共享跳转结果。 */
  attach(manager: IndexManager): void { this.manager = manager; }
  /** 通知 VS Code 重新读取树。 */
  refresh(): void { this.emitter.fire(undefined); }
  /** 查找当前光标或固定入口，更新后不猜测已经消失的入口。 */
  async entry(): Promise<{ state: State; node?: CodeNode } | undefined> {
    if (this.pinned) {
      const { state, node } = this.pinned;
      if (!this.manager.states.has(state.folder.uri.toString())) { this.pinned = undefined; return undefined; }
      const graph = await this.manager.ensure(state);
      const same = graph.nodes.get(node.id);
      const matches = [...graph.nodes.values()].filter(n => n.file === node.file && n.label === node.label && n.kind === node.kind);
      return { state, node: same?.label === node.label ? same : matches.length === 1 ? matches[0] : undefined };
    }
    const editor = vscode.window.activeTextEditor; if (!editor) return undefined;
    const state = this.manager.state(editor.document.uri); if (!state) return undefined;
    const graph = await this.manager.ensure(state);
    return { state, node: graph.nodeAt(editor.document.uri.fsPath, editor.document.offsetAt(editor.selection.active)) };
  }
  /** 返回状态、入口或上下游分支，循环节点停止展开。 */
  async getChildren(item?: Item): Promise<Item[]> {
    if (!item) {
      const entry = await this.entry();
      if (!entry) return [{ label: '请打开工作区中的 Vue / JS / PHP 文件' }];
      const { state, node } = entry;
      return [{ label: `${this.pinned ? '已固定 · ' : ''}${state.folder.name} · ${state.status}` }, ...(node ? [{ node, state, trail: [node.id] }] : [{ label: '当前位置没有可解析的业务入口' }]), ...state.graph!.errors.map(e => ({ label: path.relative(state.folder.uri.fsPath, e.file) + '：' + e.message }))];
    }
    if (!item.node || !item.state) return [];
    if (!item.direction) return [
      { ...item, label: '上游调用', direction: 'in', group: true },
      { ...item, label: '下游关联', direction: 'out', group: true },
    ];
    const graph = item.state.graph!;
    const targets = item.direction === 'in' ? graph.incoming(item.node.id) : graph.outgoing(item.node.id);
    return targets.map(node => {
      const cyclic = item.trail?.includes(node.id);
      return { node, state: item.state, direction: item.direction, trail: [...(item.trail ?? []), node.id], label: cyclic ? `${node.label}（循环，停止展开）` : undefined, group: false };
    });
  }
  /** 原生树节点包含文件位置、关系类型及可点击源码入口。 */
  getTreeItem(item: Item): vscode.TreeItem {
    const node = item.node;
    const graph = item.state?.graph;
    const cycle = !!node && (item.trail?.filter(id => id === node.id).length ?? 0) > 1;
    const hasChildren = node && !cycle && node.kind !== 'unresolved' && (!item.direction || (item.direction === 'in' ? graph?.incoming(node.id).length : graph?.outgoing(node.id).length));
    const tree = new vscode.TreeItem(item.label ?? node?.label ?? '', hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    if (item.group) { tree.iconPath = new vscode.ThemeIcon(item.direction === 'in' ? 'call-incoming' : 'call-outgoing'); return tree; }
    if (node && item.state) {
      tree.description = { page: '页面 / 函数', api: '接口', route: '路由', controller: '控制器', service: '服务', unresolved: '未解析' }[node.kind];
      tree.tooltip = `${node.detail ?? node.label}\n${path.relative(item.state.folder.uri.fsPath, node.file)}`;
      tree.iconPath = new vscode.ThemeIcon(node.kind === 'unresolved' ? 'question' : 'symbol-method');
      const location = this.manager.location(item.state, node);
      tree.command = { command: 'vscode.open', title: '打开代码', arguments: [location.uri, { selection: new vscode.Range(location.range.start, location.range.start) }] };
    }
    return tree;
  }
  /** 释放树事件。 */
  dispose(): void { this.emitter.dispose(); }
}

/** 注册代码导航、反向引用、树视图和工作区失效监听。 */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('业务链导航');
  const tree = new ChainTree();
  const manager = new IndexManager(context, output, () => tree.refresh()); tree.attach(manager);
  const view = vscode.window.createTreeView('businessNavigator.chain', { treeDataProvider: tree });
  let refreshTimer: NodeJS.Timeout | undefined;
  /** 合并快速光标事件，侧栏隐藏时不触发重建。 */
  function refreshSelection(): void {
    if (!view.visible || tree.pinned) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => tree.refresh(), 120);
  }
  /** 查询当前编辑器入口，用于命令和引用列表。 */
  async function current(): Promise<{ state: State; node?: CodeNode } | undefined> {
    const editor = vscode.window.activeTextEditor;
    const state = editor && manager.state(editor.document.uri);
    if (!state || !editor) return undefined;
    const graph = await manager.ensure(state);
    return { state, node: graph.nodeAt(editor.document.uri.fsPath, editor.document.offsetAt(editor.selection.active)) };
  }
  const selector = [{ scheme: 'file', language: 'php' }, { scheme: 'file', language: 'vue' }, { scheme: 'file', language: 'javascript' }];
  context.subscriptions.push(output, tree, manager, view,
    vscode.languages.registerDefinitionProvider(selector, {
      /** 仅返回静态关联位置，与既有语言服务共同工作。 */
      async provideDefinition(document, pos, token) {
        const state = manager.state(document.uri); if (!state) return [];
        const graph = await manager.ensure(state); if (token.isCancellationRequested) return [];
        return graph.definitions(document.uri.fsPath, document.offsetAt(pos)).map(n => manager.location(state, n));
      },
    }),
    vscode.languages.registerReferenceProvider(selector, {
      /** 从当前符号沿业务关联反向查找实际调用点。 */
      async provideReferences(document, pos, options, token) {
        const state = manager.state(document.uri); if (!state) return [];
        const graph = await manager.ensure(state); if (token.isCancellationRequested) return [];
        // 点击调用点时对目标符号查引用，方法体内则对当前方法查引用。
        const targets = graph.definitions(document.uri.fsPath, document.offsetAt(pos));
        const node = targets.length ? targets : [graph.nodeAt(document.uri.fsPath, document.offsetAt(pos))].filter(Boolean) as CodeNode[];
        const locations = new Map<string, vscode.Location>();
        for (const target of node) for (const span of [...graph.references(target.id), ...(options.includeDeclaration ? [target] : [])]) locations.set(`${span.file}:${span.start}:${span.end}`, manager.location(state, span));
        return [...locations.values()];
      },
    }),
    vscode.commands.registerCommand('businessNavigator.showChain', async () => { await vscode.commands.executeCommand('businessNavigator.chain.focus'); tree.refresh(); }),
    vscode.commands.registerCommand('businessNavigator.findRelated', async () => {
      const entry = await current(), editor = vscode.window.activeTextEditor;
      if (!entry?.node || !editor) { void vscode.window.showInformationMessage('当前位置没有可解析的业务入口'); return; }
      const locations = entry.state.graph!.references(entry.node.id).map(span => manager.location(entry.state, span));
      if (!locations.length) { void vscode.window.showInformationMessage('未找到静态关联调用'); return; }
      await vscode.commands.executeCommand('editor.action.showReferences', editor.document.uri, editor.selection.active, locations);
    }),
    vscode.commands.registerCommand('businessNavigator.rebuild', async () => {
      const state = vscode.window.activeTextEditor && manager.state(vscode.window.activeTextEditor.document.uri);
      if (state) { state.dirty = true; state.revision++; await manager.ensure(state); }
      else for (const s of manager.states.values()) { s.dirty = true; s.revision++; await manager.ensure(s); }
      tree.refresh();
    }),
    vscode.commands.registerCommand('businessNavigator.togglePin', async () => {
      if (tree.pinned) tree.pinned = undefined;
      else { const entry = await current(); if (entry?.node) tree.pinned = { state: entry.state, node: entry.node }; }
      tree.refresh();
    }),
    view.onDidChangeVisibility(e => { if (e.visible) tree.refresh(); }),
    vscode.window.onDidChangeActiveTextEditor(refreshSelection),
    vscode.window.onDidChangeTextEditorSelection(refreshSelection),
    vscode.workspace.onDidChangeTextDocument(e => { if (e.contentChanges.length && /\.(php|js|vue|json)$/.test(e.document.fileName)) manager.invalidate(e.document.uri); }),
    vscode.workspace.onDidSaveTextDocument(d => manager.invalidate(d.uri)),
    vscode.workspace.onDidCloseTextDocument(d => { if (d.uri.scheme === 'file') manager.invalidate(d.uri); }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('businessNavigator')) manager.invalidate(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { manager.prune(); tree.refresh(); }),
    { dispose: () => { if (refreshTimer) clearTimeout(refreshTimer); } },
  );
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{php,js,vue,json}');
  context.subscriptions.push(watcher, watcher.onDidChange(uri => manager.invalidate(uri)), watcher.onDidCreate(uri => manager.invalidate(uri)), watcher.onDidDelete(uri => manager.invalidate(uri)));
}
