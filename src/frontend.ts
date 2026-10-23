import path from 'node:path';
import { parse } from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import { parse as parseJson } from 'jsonc-parser';
import { CodeNode, Edge, Endpoint, FrontendResult, IndexOptions, Span, nodeId } from './types';
const { parseComponent } = require('vue-template-compiler/build');
type Ast = any;
interface Module {
  file: string; ast: Ast; offset: number; root: CodeNode;
  imports: Map<string, { file: string; name: string }>;
  exports: Map<string, string>; functions: Map<Ast, CodeNode>; bindings: Map<string, CodeNode>;
  classes: Map<string, { ast: Ast; name: string; uri?: string; methods: Map<string, CodeNode> }>;
}

/** 读取 AST 属性名，拒绝动态计算的键。 */
function key(node: Ast): string | undefined {
  if (!node) return undefined;
  if (node.computed && node.key?.type !== 'StringLiteral') return undefined;
  return node.key ? key(node.key) : node.name ?? (typeof node.value === 'string' ? node.value : undefined);
}
/** 在模块内解析 import 路径，不访问磁盘或加载源码。 */
function resolver(files: Map<string, string>, root: string): (file: string, spec: string) => string | undefined {
  const config = parseJson(files.get(path.join(root, 'jsconfig.json')) ?? '{}');
  const base = path.resolve(root, config?.compilerOptions?.baseUrl ?? '.');
  const aliases = Object.entries(config?.compilerOptions?.paths ?? { '@/*': ['resources/js/*'] }) as [string, string[]][];
  return (file, spec) => {
    let choices: string[] = [];
    if (spec.startsWith('.')) choices = [path.resolve(path.dirname(file), spec)];
    else for (const [pattern, targets] of aliases) {
      const [prefix, suffix = ''] = pattern.split('*');
      if ((pattern.includes('*') && spec.startsWith(prefix) && spec.endsWith(suffix)) || spec === pattern) {
        const middle = pattern.includes('*') ? spec.slice(prefix.length, suffix ? -suffix.length : undefined) : '';
        choices.push(...targets.map(target => path.resolve(base, target.replace('*', middle))));
      }
    }
    return choices.flatMap(p => [p, p + '.js', p + '.vue', path.join(p, 'index.js')]).find(p => files.has(p));
  };
}
/** 找到词法绑定的初始值；仅接受 const，避免把可变变量误作常量。 */
function constant(p: NodePath, name: string): NodePath | undefined {
  const binding = p.scope.getBinding(name);
  if (!binding?.constant || !binding.path.isVariableDeclarator() || (binding.path.parentPath?.node as Ast).kind !== 'const') return undefined;
  return binding.path.get('init') as NodePath;
}
/** 有界求值 URL 表达式，未知值保留为动态路径段，调用结果不作猜测。 */
function value(p: NodePath | undefined, uri?: string, seen = new Set<Ast>()): string | undefined {
  const n = p?.node as Ast;
  if (!n || seen.has(n) || seen.size > 30) return undefined;
  const next = new Set(seen).add(n);
  if (n.type === 'StringLiteral' || n.type === 'NumericLiteral') return String(n.value);
  if (n.type === 'Identifier') {
    const init = constant(p!, n.name);
    return init ? value(init, uri, next) : '{dynamic}';
  }
  if (n.type === 'MemberExpression' && n.object.type === 'ThisExpression' && key(n.property) === 'uri') return uri ?? '{resource}';
  if (n.type === 'BinaryExpression' && n.operator === '+') {
    const left = value(p!.get('left') as NodePath, uri, next), right = value(p!.get('right') as NodePath, uri, next);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (n.type === 'TemplateLiteral') {
    const expressions = p!.get('expressions') as NodePath[];
    let output = n.quasis[0].value.cooked;
    for (let i = 0; i < expressions.length; i++) {
      const part = value(expressions[i], uri, next);
      if (part === undefined) return undefined;
      output += part + n.quasis[i + 1].value.cooked;
    }
    return output;
  }
  return undefined;
}
/** 生成原始文件的 UTF-16 范围。 */
function span(m: Module, n: Ast): Span { return { file: m.file, start: (n.start ?? 0) + m.offset, end: (n.end ?? 0) + m.offset }; }
/** 解析可确定的前端模块、请求与直接调用关系。 */
export function analyzeFrontend(files: Map<string, string>, root: string, options: IndexOptions): FrontendResult {
  const result: FrontendResult = { nodes: [], edges: [], endpoints: [], errors: [] };
  const modules = new Map<string, Module>();
  const resolve = resolver(files, root);
  const requests = new Set(options.requestModules.map(f => path.resolve(root, f)));
  for (const [file, source] of files) {
    if (!/\.(js|vue)$/.test(file) || requests.has(file)) continue;
    try {
      let code = source, offset = 0;
      if (file.endsWith('.vue')) {
        const sfc = parseComponent(source, { pad: false });
        if (!sfc.script) continue;
        code = sfc.script.content; offset = sfc.script.start;
      }
      const ast = parse(code, { sourceType: 'unambiguous', plugins: ['dynamicImport', 'jsx', 'classProperties', 'objectRestSpread', 'optionalChaining'] });
      const rootNode: CodeNode = { id: nodeId(file, 0, 'file'), kind: 'page', label: path.basename(file), file, start: 0, end: source.length };
      const m: Module = { file, ast, offset, root: rootNode, imports: new Map(), exports: new Map(), functions: new Map(), bindings: new Map(), classes: new Map() };
      modules.set(file, m); result.nodes.push(rootNode);
      traverse(ast, {
        ImportDeclaration(p) {
          const target = resolve(file, p.node.source.value);
          if (!target) return;
          for (const s of p.node.specifiers) m.imports.set(s.local.name, { file: target, name: s.type === 'ImportDefaultSpecifier' ? 'default' : s.type === 'ImportNamespaceSpecifier' ? '*' : key(s.imported)! });
        },
        Class(p) {
          const n = p.node as Ast;
          const name = n.id?.name ?? 'default';
          let uri: string | undefined;
          const constructor = (p.get('body.body') as NodePath[]).find(x => x.node.type === 'ClassMethod' && (x.node as Ast).kind === 'constructor');
          constructor?.traverse({ CallExpression(call) { if (call.node.callee.type === 'Super') uri = value((call.get('arguments') as NodePath[])[0]); } });
          m.classes.set(name, { ast: n, name, uri, methods: new Map() });
          if (p.parentPath.isExportDefaultDeclaration()) m.exports.set('default', name);
          if (p.parentPath.isExportNamedDeclaration()) m.exports.set(name, name);
        },
        Function(p) {
          const n = p.node as Ast;
          const parent = p.parentPath.node as Ast;
          const name = n.id?.name ?? key(n.key) ?? (parent.type === 'VariableDeclarator' ? parent.id.name : key(parent.key)) ?? `回调:${(n.loc?.start.line ?? 1)}`;
          const location = span(m, n);
          const node: CodeNode = { ...location, id: nodeId(file, location.start, 'function'), label: name, kind: /[/\\]api[/\\]/.test(file) ? 'api' : 'page' };
          m.functions.set(n, node); result.nodes.push(node);
          const isClassMethod = p.isClassMethod();
          if (isClassMethod) {
            const cls = p.findParent(x => x.isClass())?.node as Ast;
            m.classes.get(cls?.id?.name ?? 'default')?.methods.set(name, node);
          } else if (p.isFunctionDeclaration() || parent.type === 'VariableDeclarator') m.bindings.set(name, node);
          if (p.parentPath.isExportDefaultDeclaration()) m.exports.set('default', name);
          if (p.parentPath.isExportNamedDeclaration() || p.parentPath.parentPath?.isExportNamedDeclaration() || (p.parentPath.isVariableDeclarator() && p.parentPath.parentPath?.parentPath?.isExportNamedDeclaration())) m.exports.set(name, name);
        },
        ExportNamedDeclaration(p) {
          for (const s of p.node.specifiers) if (s.type === 'ExportSpecifier') {
            if (p.node.source) {
              const target = resolve(file, p.node.source.value);
              if (target) m.imports.set(`export:${key(s.exported)}`, { file: target, name: key(s.local)! });
              m.exports.set(key(s.exported)!, `export:${key(s.exported)}`);
            } else m.exports.set(key(s.exported)!, key(s.local)!);
          }
        },
        ExportDefaultDeclaration(p) { if (p.node.declaration.type === 'Identifier') m.exports.set('default', p.node.declaration.name); },
      });
    } catch (e) {
      result.errors.push({ file, message: `前端语法解析失败（行 ${(e as any)?.loc?.line ?? '?'}）` });
      modules.delete(file);
    }
  }
  /** 跟随明确导入和再导出，不跨未知绑定猜测符号。 */
  function imported(m: Module, name: string, seen = new Set<string>()): { m: Module; name: string } | undefined {
    const id = m.file + ':' + name;
    if (seen.has(id)) return undefined;
    seen.add(id);
    const imp = m.imports.get(name);
    if (!imp) return { m, name };
    const target = modules.get(imp.file);
    if (!target) return undefined;
    const actual = target.exports.get(imp.name);
    return actual ? imported(target, actual, seen) : undefined;
  }
  /** 查找函数的最内层所属节点。 */
  function owner(m: Module, p: NodePath): CodeNode {
    let cursor: NodePath | null = p;
    while (cursor) { const found = m.functions.get(cursor.node); if (found) return found; cursor = cursor.parentPath; }
    return m.root;
  }
  const specialized = new Map<string, CodeNode>();
  const requestCalls = new Map<string, { methodNode: CodeNode; path: NodePath; url: NodePath; method: string; cls?: string }[]>();
  for (const m of modules.values()) {
    traverse(m.ast, {
      CallExpression(p) {
        const callee = p.node.callee as Ast;
        if (callee.type === 'Import' && p.node.arguments[0]?.type === 'StringLiteral') {
          const target = modules.get(resolve(m.file, p.node.arguments[0].value) ?? '');
          if (target) result.edges.push({ from: m.root.id, to: target.root.id, site: span(m, p.node.arguments[0]) });
          return;
        }
        const fn = owner(m, p);
        // 只接受来自已配置请求模块的绑定，避免误认同名函数。
        const binding = callee.type === 'Identifier' ? p.scope.getBinding(callee.name) : undefined;
        const imp = callee.type === 'Identifier' && binding?.path.isImportDefaultSpecifier() ? m.imports.get(callee.name) : undefined;
        if (imp && requests.has(imp.file)) {
          const arg = (p.get('arguments') as NodePath[])[0];
          if (!arg?.isObjectExpression()) return;
          const props = arg.get('properties') as NodePath[];
          const urlProp = props.find(x => key(x.node) === 'url');
          if (!urlProp?.isObjectProperty()) return;
          const methodProp = props.find(x => key(x.node) === 'method');
          const method = methodProp?.isObjectProperty() ? value(methodProp.get('value') as NodePath) : 'GET';
          const cls = p.findParent(x => x.isClass())?.node as Ast;
          const calls = requestCalls.get(m.file) ?? [];
          calls.push({ methodNode: fn, path: p, url: urlProp.get('value') as NodePath, method: (method ?? 'UNKNOWN').toUpperCase(), cls: cls ? cls.id?.name ?? 'default' : undefined });
          requestCalls.set(m.file, calls);
          return;
        }
        let target: CodeNode | undefined;
        if (callee.type === 'Identifier') {
          const resolved = imported(m, callee.name);
          // 局部参数或变量遮蔽 import 时不建立跨模块关联。
          if (!m.imports.has(callee.name) || binding?.path.isImportSpecifier() || binding?.path.isImportDefaultSpecifier()) target = resolved?.m.bindings.get(resolved.name);
        } else if (callee.type === 'MemberExpression') {
          const method = callee.computed && callee.property.type !== 'StringLiteral' ? undefined : key(callee.property);
          if (callee.object.type === 'ThisExpression') {
            const candidates = [...m.functions.values()].filter(n => n.label === method && n.kind === 'page');
            if (candidates.length === 1) target = candidates[0];
          } else if (callee.object.type === 'Identifier') {
            const variable = p.scope.getBinding(callee.object.name);
            const init = variable?.constant && variable.path.isVariableDeclarator() ? variable.path.node.init as Ast : undefined;
            if (init?.type === 'NewExpression' && init.callee.type === 'Identifier') {
              const cls = imported(m, init.callee.name);
              if (cls && method) {
                const declaration = cls.m.classes.get(cls.name);
                const classBinding = p.scope.getBinding(init.callee.name);
                const isKnownClass = classBinding?.path.isImportDefaultSpecifier() || classBinding?.path.isImportSpecifier() || classBinding?.path.isClassDeclaration();
                let uri: string | undefined;
                if (isKnownClass && declaration && !declaration.ast.superClass) {
                  const initPath = variable!.path.get('init') as NodePath;
                  const first = (initPath.get('arguments') as NodePath[])[0];
                  uri = value(first);
                }
                if (isKnownClass) target = resourceMethod(cls.m, cls.name, method, uri);
              }
            } else {
              const namespace = m.imports.get(callee.object.name);
              if (namespace?.name === '*' && variable?.path.isImportNamespaceSpecifier() && method) {
                const module = modules.get(namespace.file);
                const resolved = module && imported(module, module.exports.get(method) ?? '');
                target = resolved?.m.bindings.get(resolved.name);
              }
            }
          }
        }
        if (target && target.id !== fn.id) result.edges.push({ from: fn.id, to: target.id, site: span(m, callee.type === 'MemberExpression' ? callee.property : callee) });
      },
    });
    // 文件级入口可展开到页面方法；API 文件入口也可浏览导出的接口。
    for (const node of m.functions.values()) {
      if (!result.edges.some(e => e.from === m.root.id && e.to === node.id)) result.edges.push({ from: m.root.id, to: node.id, site: { file: node.file, start: node.start, end: node.start } });
    }
  }
  /** 将 Resource 继承方法绑定到确定 URI，避免 users/roles 共享错误地址。 */
  function resourceMethod(m: Module, className: string, method: string, uri?: string, seen = new Set<string>()): CodeNode | undefined {
    const cls = m.classes.get(className);
    if (!cls || seen.has(m.file + ':' + className)) return undefined;
    seen.add(m.file + ':' + className);
    uri = uri ?? cls.uri;
    const own = cls.methods.get(method);
    if (own) {
      if (!uri || uri.includes('{')) return own;
      const id = own.id + ':resource:' + uri;
      const cached = specialized.get(id); if (cached) return cached;
      const node: CodeNode = { ...own, id, label: `${className}.${method} [${uri}]`, kind: 'api' };
      specialized.set(id, node); result.nodes.push(node);
      // 请求收集可能尚未进行到基类，直接使用方法路径扫描请求。
      const requestsForMethod = requestCalls.get(m.file)?.filter(c => c.methodNode.id === own.id) ?? [];
      for (const call of requestsForMethod) result.endpoints.push({ node, method: call.method, path: value(call.url, uri), urlSite: span(m, call.url.node) });
      return node;
    }
    const superName = cls.ast.superClass?.name;
    const parent = superName && imported(m, superName);
    return parent ? resourceMethod(parent.m, parent.name, method, uri, seen) : undefined;
  }
  // 第一次遍历期间 Resource 请求可能晚于调用者才被收集，重建其端点以消除文件顺序影响。
  for (const node of specialized.values()) {
    if (result.endpoints.some(e => e.node.id === node.id)) continue;
    const original = node.id.slice(0, node.id.lastIndexOf(':resource:'));
    const uri = node.id.slice(node.id.lastIndexOf(':resource:') + 10);
    const m = modules.get(node.file)!;
    for (const call of requestCalls.get(m.file) ?? []) if (call.methodNode.id === original) result.endpoints.push({ node, method: call.method, path: value(call.url, uri), urlSite: span(m, call.url.node) });
  }
  for (const [file, calls] of requestCalls) for (const call of calls) {
    const m = modules.get(file)!;
    // 模板 Resource 方法仅在具体实例中建立端点，不能把 {resource} 当作任意资源。
    const url = value(call.url, call.cls ? m.classes.get(call.cls)?.uri : undefined);
    if (url?.includes('{resource}')) continue;
    result.endpoints.push({ node: call.methodNode, method: call.method, path: url, urlSite: span(m, call.url.node) });
  }
  return result;
}
