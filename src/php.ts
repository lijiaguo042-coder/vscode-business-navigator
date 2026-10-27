import * as path from 'node:path';
import { CodeNode, PhpResult, Span, nodeId } from './types';
// php-parser 提供 PHP 语法树；分析过程不加载 PHP 文件或执行应用代码。
const Engine = require('php-parser');
type Ast = any;
interface Context { namespace: string; aliases: Map<string, string>; providerNamespace?: string }
interface Group { prefix: string; namespace: string }

/** 遍历语法节点，跳过位置元数据。 */
function walk(node: Ast, visit: (node: Ast) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit)); return; }
  if (node.kind) visit(node);
  for (const key of Object.keys(node)) if (key !== 'loc' && key !== 'tokens' && key !== 'comments') walk(node[key], visit);
}
/** 读取 AST 标识符，不把动态表达式当作静态名称。 */
function name(node: Ast): string { return typeof node === 'string' ? node : typeof node?.name === 'string' ? node.name : ''; }
/** 将语法树位置转换为编辑器源码范围。 */
function span(file: string, node: Ast): Span { return { file, start: node?.loc?.start?.offset || 0, end: node?.loc?.end?.offset || 0 }; }
/** 根据当前 namespace/use 解析类名。 */
function resolveClass(node: Ast, context: Context, current = ''): string | undefined {
  if (node && typeof node !== 'string' && !['name','identifier','typereference','selfreference','staticreference','parentreference'].includes(node.kind)) return undefined;
  const raw = name(node) || node?.raw || '';
  if (!raw || ['string','int','bool','float','array','callable','iterable','object','void','mixed'].includes(raw.toLowerCase())) return undefined;
  if (['self', 'static'].includes(raw.toLowerCase())) return current || undefined;
  if (raw.toLowerCase() === 'parent') return undefined;
  if (raw.startsWith('\\')) return raw.slice(1);
  const parts = raw.split('\\');
  const alias = context.aliases.get(parts[0].toLowerCase());
  if (alias) return [alias, ...parts.slice(1)].join('\\');
  return [context.namespace, raw].filter(Boolean).join('\\');
}
/** 提取静态字符串、数组及 provider namespace。 */
function value(node: Ast, context: Context): any {
  if (!node) return undefined;
  if (node.kind === 'string' || node.kind === 'number') return node.value;
  if (node.kind === 'propertylookup' && name(node.what) === 'this' && name(node.offset) === 'namespace') return context.providerNamespace;
  if (node.kind === 'array') {
    const items = node.items || [];
    if (items.some((entry: Ast) => entry?.key)) {
      const result: Record<string, any> = {};
      for (const entry of items) { const key = value(entry?.key, context); if (key !== undefined) result[key] = value(entry.value, context); }
      return result;
    }
    return items.map((entry: Ast) => value(entry?.value, context));
  }
  if (node.kind === 'staticlookup' && node.offset?.kind === 'identifier' && name(node.offset).toLowerCase() === 'class') return resolveClass(node.what, context);
  if (node.kind === 'bin' && node.type === '.') {
    const left = value(node.left, context), right = value(node.right, context);
    return typeof left === 'string' && typeof right === 'string' ? left + right : undefined;
  }
  return undefined;
}
/** 合并 Laravel 路由组路径和控制器命名空间。 */
function mergeGroup(group: Group, attributes: any): Group {
  return {
    prefix: [group.prefix, typeof attributes?.prefix === 'string' ? attributes.prefix : ''].filter(Boolean).join('/'),
    namespace: typeof attributes?.namespace === 'string' ? (attributes.namespace.startsWith('\\') ? attributes.namespace.slice(1) : [group.namespace, attributes.namespace].filter(Boolean).join('\\')) : group.namespace,
  };
}
/** 展开以 Route facade 为起点的 fluent 调用。 */
function routeChain(node: Ast, context: Context): { method: string; args: Ast[] }[] | undefined {
  if (node?.kind !== 'call') return undefined;
  const target = node.what;
  if (target?.kind === 'staticlookup') {
    const resolved = resolveClass(target.what, context);
    if (!['Route', 'Illuminate\\Support\\Facades\\Route'].includes(resolved || '')) return undefined;
    return [{ method: name(target.offset).toLowerCase(), args: node.arguments || [] }];
  }
  if (target?.kind === 'propertylookup') {
    const preceding = routeChain(target.what, context);
    if (preceding) return [...preceding, { method: name(target.offset).toLowerCase(), args: node.arguments || [] }];
  }
  return undefined;
}
/** 单数化 Laravel 常用资源名；未知词保留原名，避免错误删除字符。 */
function singular(word: string): string {
  const irregular: Record<string, string> = { people: 'person', children: 'child', men: 'man', women: 'woman', mice: 'mouse', geese: 'goose', teeth: 'tooth', feet: 'foot', data: 'datum' };
  if (irregular[word]) return irregular[word];
  if (/(news|series|species|status)$/.test(word)) return word;
  if (/ies$/.test(word)) return word.slice(0, -3) + 'y';
  if (/(ches|shes|sses|xes|zes)$/.test(word)) return word.slice(0, -2);
  return /s$/.test(word) ? word.slice(0, -1) : word;
}
/** 静态分析 PHP 路由与应用类方法，所有输入均来自工作区快照。 */
export function analyzePhp(files: Map<string, string>, root: string, entrypoints: string[]): PhpResult {
  const result: PhpResult = { routes: [], methods: [], errors: [] };
  const parser = new Engine({ parser: { version: '7.1', suppressErrors: false }, ast: { withPositions: true } });
  const parsed = new Map<string, Ast>();
  const contexts = new WeakMap<object, Context>();
  const classes: { file: string; node: Ast; context: Context; className: string }[] = [];
  /** 延迟解析路由文件，并记录不含源码的语法错误。 */
  function parse(file: string): Ast | undefined {
    if (parsed.has(file)) return parsed.get(file);
    const source = files.get(file);
    if (source === undefined) return undefined;
    try {
      const ast = parser.parseCode(source, file);
      parsed.set(file, ast);
      collect(ast, { namespace: '', aliases: new Map() }, file);
      return ast;
    } catch (error: any) {
      parsed.set(file, undefined);
      result.errors.push({ file, message: `PHP 语法解析失败${Number.isInteger(error.lineNumber) ? `，第 ${error.lineNumber} 行` : ''}` });
      return undefined;
    }
  }
  /** 收集各 namespace 内的 use 别名与类声明。 */
  function collect(node: Ast, context: Context, file: string): void {
    const children = node.children || [];
    const local: Context = { ...context, aliases: new Map(context.aliases) };
    for (const child of children) {
      if (child.kind === 'usegroup' && !child.type) for (const item of child.items || []) {
        if (item.type) continue;
        const full = [child.name, item.name].filter(Boolean).join('\\').replace(/^\\/, '');
        local.aliases.set((name(item.alias) || full.split('\\').pop()!).toLowerCase(), full);
      }
    }
    contexts.set(node, local);
    for (const child of children) {
      if (child.kind === 'namespace') collect(child, { namespace: name(child), aliases: new Map() }, file);
      else if (child.kind === 'class' && child.name) {
        const own = { ...local };
        for (const member of child.body || []) if (member.kind === 'propertystatement') for (const prop of member.properties || []) if (name(prop.name) === 'namespace') own.providerNamespace = value(prop.value, own);
        contexts.set(child, own);
        classes.push({ file, node: child, context: own, className: [own.namespace, name(child.name)].filter(Boolean).join('\\') });
      }
    }
  }
  // 类方法需要跨文件解析；路由只解析从入口实际加载的文件。
  for (const file of files.keys()) if (file.endsWith('.php') && !file.split(path.sep).includes('routes')) parse(file);
    /** 加载路由文件，保留每次 group 上下文并阻止循环引用。 */
  function load(file: string, group: Group, stack: Set<string>): void {
    if (stack.has(file)) return;
    const ast = parse(file);
    if (!ast) return;
    visitRoutes(ast, file, contexts.get(ast) || { namespace: '', aliases: new Map() }, group, new Set([...stack, file]));
  }
  /** 解析 handler 字符串或类数组，保持处理器的精确源码范围。 */
  function handler(node: Ast, context: Context, group: Group): { controller?: string; action?: string; handler?: Span } {
    const decoded = value(node, context);
    if (typeof decoded === 'string') {
      const [controller, action = '__invoke'] = decoded.split('@');
      return { controller: node?.kind === 'staticlookup' ? controller : controller.startsWith('\\') ? controller.slice(1) : [group.namespace, controller].filter(Boolean).join('\\'), action };
    }
    if (node?.kind === 'array') {
      const items = node.items || [];
      if (Array.isArray(decoded) && decoded.length === 2 && typeof decoded[0] === 'string' && typeof decoded[1] === 'string') {
        const first = items[0]?.value;
        const controller = first?.kind === 'staticlookup' ? decoded[0] : decoded[0].replace(/^\\/, '');
        return { controller, action: decoded[1] };
      }
      if (decoded?.uses) return handler(node.items.find((item: Ast) => value(item.key, context) === 'uses')?.value, context, group);
    }
    return {};
  }
  /** 写入普通或资源展开后的路由节点。 */
  function addRoute(file: string, call: Ast, routePath: string, methods: string[], target: Ast, context: Context, group: Group, action?: string): void {
    const normalized = '/' + [group.prefix, routePath].join('/').split('/').filter(Boolean).join('/');
    const resolved = handler(target, context, group);
    if (action) resolved.action = action;
    const location = span(file, call);
    const node: CodeNode = { ...location, id: nodeId(file, location.start, `route:${methods.join(',')}:${normalized}`), kind: 'route', label: `${methods.join('|')} ${normalized}` };
    result.routes.push({ node, methods, path: normalized, ...resolved, handler: target ? span(file, target) : undefined });
  }
  /** 遍历可达代码的 Route 调用，递归处理 group 与外部路由文件。 */
  function visitRoutes(node: Ast, file: string, context: Context, group: Group, stack: Set<string>): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(child => visitRoutes(child, file, context, group, stack)); return; }
    if (node.kind === 'class' || node.kind === 'method') return;
    const scoped = contexts.get(node) || context;
    const chain = routeChain(node, scoped);
    if (chain) {
      let current = { ...group };
      for (const step of chain) if (step.method === 'prefix' || step.method === 'namespace') current = mergeGroup(current, { [step.method]: value(step.args[0], scoped) });
      const registration = chain.find(step => ['group','get','post','put','patch','delete','options','head','any','match','resource','apiresource','resources','apiresources'].includes(step.method));
      if (!registration) return;
      const { method, args } = registration;
      if (method === 'group') {
        let body = args[0];
        if (args.length > 1) { current = mergeGroup(current, value(args[0], scoped)); body = args[1]; }
        if (body?.kind === 'closure') visitRoutes(body.body, file, scoped, current, stack);
        else {
          let target = value(body, scoped);
          if (body?.kind === 'call' && ['base_path','app_path'].includes(name(body.what))) {
            const relative = value(body.arguments?.[0], scoped);
            if (typeof relative === 'string') target = path.resolve(root, name(body.what) === 'app_path' ? 'app' : '', relative);
          }
          if (typeof target === 'string') load(path.resolve(root, target), current, stack);
        }
      } else if (['resource','apiresource','resources','apiresources'].includes(method)) {
        const entries: [string, Ast][] = [];
        if (method.endsWith('resources')) {
          for (const entry of args[0]?.items || []) { const key = value(entry.key, scoped); if (typeof key === 'string') entries.push([key, entry.value]); }
        } else { const key = value(args[0], scoped); if (typeof key === 'string') entries.push([key, args[1]]); }
        for (const [resource, target] of entries) {
          const pieces = resource.split('.');
          const options = value(args[method.endsWith('resources') ? 1 : 2], scoped) || {};
          for (const step of chain) if (['only','except','parameters'].includes(step.method)) options[step.method] = step.args.length > 1 && step.method !== 'parameters' ? step.args.map(argument => value(argument, scoped)) : value(step.args[0], scoped);
          const parameters = options.parameters || {};
          const segments: string[] = [];
          for (const piece of pieces.slice(0,-1)) segments.push(piece, `{${parameters[piece] || singular(piece.replace(/-/g,'_'))}}`);
          segments.push(pieces[pieces.length-1]);
          const base = segments.join('/');
          const item = `${base}/{${parameters[pieces[pieces.length-1]] || singular(pieces[pieces.length-1].replace(/-/g,'_'))}}`;
          const definitions: [string,string[],string][] = [['index',['GET','HEAD'],base],['create',['GET','HEAD'],`${base}/create`],['store',['POST'],base],['show',['GET','HEAD'],item],['edit',['GET','HEAD'],`${item}/edit`],['update',['PUT','PATCH'],item],['destroy',['DELETE'],item]];
          for (const [action, methods, uri] of definitions) {
            const only = typeof options.only === 'string' ? [options.only] : options.only;
            const except = typeof options.except === 'string' ? [options.except] : options.except;
            if ((method.startsWith('api') && ['create','edit'].includes(action)) || (Array.isArray(only) && !only.includes(action)) || (Array.isArray(except) && except.includes(action))) continue;
            addRoute(file,node,uri,methods,target,scoped,current,action);
          }
        }
      } else {
        const offset = method === 'match' ? 1 : 0;
        const uri = value(args[offset], scoped);
        if (typeof uri === 'string') {
          const verbs = method === 'any' ? ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'] : method === 'match' ? value(args[0], scoped) : method === 'get' ? ['GET','HEAD'] : [method.toUpperCase()];
          if (Array.isArray(verbs) && verbs.every(item => typeof item === 'string')) addRoute(file,node,uri,verbs.map(item=>item.toUpperCase()),args[offset+1],scoped,current);
        }
      }
      return;
    }
    for (const key of Object.keys(node)) if (key !== 'loc' && key !== 'comments') visitRoutes(node[key],file,scoped,group,stack);
  }
  for (const configured of entrypoints) {
    const file = path.resolve(root, configured), ast = parse(file);
    if (!ast) continue;
    const providers = classes.filter(item => item.file === file);
    visitRoutes(ast,file,contexts.get(ast) || { namespace:'',aliases:new Map() },{prefix:'',namespace:''},new Set([file]));
    for (const provider of providers) {
      const methods = new Map<string, Ast>((provider.node.body || []).filter((member: Ast) => member.kind === 'method').map((member: Ast) => [name(member.name),member]));
      const visited = new Set<string>();
      /** 仅跟踪 provider 生命周期显式调用的方法。 */
      function visitProvider(methodName: string): void {
        if (visited.has(methodName)) return;
        visited.add(methodName);
        const method = methods.get(methodName);
        if (!method) return;
        visitRoutes(method.body,file,provider.context,{prefix:'',namespace:''},new Set([file]));
        walk(method.body, child => { if (child.kind === 'call' && child.what?.kind === 'propertylookup' && name(child.what.what) === 'this') visitProvider(name(child.what.offset)); });
      }
      visitProvider('map'); visitProvider('boot');
    }
  }
  const bindings = new Map<string, Set<string | undefined>>();
  let dynamicBinding = false;
  for (const provider of classes) {
    if (resolveClass(provider.node.extends, provider.context)?.toLowerCase() !== 'illuminate\\support\\serviceprovider') continue;
    for (const member of provider.node.body || []) {
      if (member.kind !== 'method' || !['register', 'boot'].includes(name(member.name).toLowerCase())) continue;
      const direct = new Set<Ast>();
      // 仅接受直线语句前缀中的绑定，遇到分支或退出后不假定后续代码必然执行。
      for (const statement of member.body?.children || []) {
        if (statement.kind !== 'expressionstatement') break;
        direct.add(statement.expression);
      }
      walk(member.body, child => {
        if (child.kind !== 'call' || child.what?.kind !== 'propertylookup') return;
        const receiver = child.what.what;
        if (receiver?.kind !== 'propertylookup' || receiver.what?.kind !== 'variable' || name(receiver.what) !== 'this' || receiver.offset?.kind !== 'identifier' || name(receiver.offset) !== 'app') return;
        if (!['singleton', 'bind'].includes(name(child.what.offset).toLowerCase()) || child.what.offset?.kind !== 'identifier') return;
        const key = value(child.arguments?.[0], provider.context);
        if (typeof key !== 'string' || !key) { dynamicBinding = true; return; }
        const concrete = child.arguments?.[1];
        let target: string | undefined;
        if (direct.has(child)) {
          if (concrete?.kind === 'closure') {
            const statements = concrete.body?.children || [];
            if (statements.length === 1 && statements[0].kind === 'return' && statements[0].expr?.kind === 'new') target = resolveClass(statements[0].expr.what, provider.context);
          } else {
            const decoded = value(concrete, provider.context);
            if (typeof decoded === 'string' && /^\\?[a-z_][a-z\d_]*(?:\\[a-z_][a-z\d_]*)*$/i.test(decoded)) target = decoded.replace(/^\\/, '');
          }
        }
        const candidates = bindings.get(key) ?? new Set<string | undefined>();
        candidates.add(target?.toLowerCase()); bindings.set(key, candidates);
      });
    }
  }
  const facades = new Map<string, { target?: string; methods: Map<string, string> }>();
  for (const item of classes) {
    if (resolveClass(item.node.extends, item.context)?.toLowerCase() !== 'illuminate\\support\\facades\\facade') continue;
    const members = (item.node.body || []).filter((member: Ast) => member.kind === 'method');
    const accessor = members.find((member: Ast) => name(member.name).toLowerCase() === 'getfacadeaccessor' && member.isStatic);
    const statements = accessor?.body?.children || [];
    const key = statements.length === 1 && statements[0].kind === 'return' ? value(statements[0].expr, item.context) : undefined;
    let target: string | undefined;
    if (typeof key === 'string' && key && !dynamicBinding) {
      const candidates = bindings.get(key);
      if (candidates?.size === 1) target = [...candidates][0];
      else if (!candidates && statements[0].expr.kind === 'staticlookup') target = key.toLowerCase();
    }
    facades.set(item.className.toLowerCase(), { target, methods: new Map<string, string>(members.map((member: Ast) => [name(member.name).toLowerCase(), member.visibility || 'public'])) });
  }
  for (const item of classes) {
    if (!item.file.includes(`${path.sep}app${path.sep}`) || item.file.includes(`${path.sep}Providers${path.sep}`)) continue;
    const members: Ast[] = (item.node.body || []).filter((member: Ast) => member.kind === 'method');
    const properties = new Map<string,string>();
    for (const member of members.filter(member => name(member.name) === '__construct')) {
      const params = new Map<string,string>();
      for (const parameter of member.arguments || []) { const cls = resolveClass(parameter.type,item.context,item.className); if (cls && !['string','int','bool','float','array','callable','iterable','object'].includes(name(parameter.type))) params.set(name(parameter.name),cls); }
      walk(member.body, child => {
        if (child.kind === 'assign' && child.left?.kind === 'propertylookup' && name(child.left.what) === 'this') {
          const cls = child.right?.kind === 'variable' ? params.get(name(child.right)) : child.right?.kind === 'new' ? resolveClass(child.right.what,item.context,item.className) : undefined;
          if (cls) properties.set(name(child.left.offset),cls);
        }
      });
    }
    // 条件构造赋值没有唯一初始化类型，也不能沿用最后遍历到的分支。
    for (const member of members.filter(member => name(member.name) === '__construct')) walk(member.body, branch => {
      if (!['if','switch','foreach','for','while','do','try','retif'].includes(branch.kind)) return;
      walk(branch, child => {
        if (['assign','assignref'].includes(child.kind) && child.left?.kind === 'propertylookup' && name(child.left.what) === 'this') properties.delete(name(child.left.offset));
      });
    });
    // 构造器注入属性一旦在其他方法中重赋值，实例后续状态无法由调用顺序确定。
    for (const member of members.filter(member => name(member.name) !== '__construct')) walk(member.body, child => {
      if (['assign','assignref'].includes(child.kind) && child.left?.kind === 'propertylookup' && name(child.left.what) === 'this') properties.delete(name(child.left.offset));
    });
    for (const member of members) {
      const location = span(item.file,member), methodName = name(member.name);
      const node: CodeNode = { ...location,id:nodeId(item.file,location.start,'method'),kind:item.file.includes(`${path.sep}Controllers${path.sep}`)?'controller':'service',label:`${name(item.node.name)}::${methodName}`,detail:item.className };
      const calls: PhpResult['methods'][number]['calls'] = [];
      const variables = new Map<string,string>();
      const conditionalVariables = new Set<string>();
      // 本版不合并控制流类型；条件、循环和异常分支中的赋值统一降为未知。
      walk(member.body, branch => {
        if (!['if','switch','foreach','for','while','do','try','retif'].includes(branch.kind)) return;
        walk(branch, child => {
          if (['assign','assignref'].includes(child.kind) && child.left?.kind === 'variable') conditionalVariables.add(name(child.left));
          if (child.kind === 'foreach' && child.value?.kind === 'variable') conditionalVariables.add(name(child.value));
        });
      });
      for (const parameter of member.arguments || []) { const cls = resolveClass(parameter.type,item.context,item.className); if (cls && !conditionalVariables.has(name(parameter.name))) variables.set(name(parameter.name),cls); }
      walk(member.body, child => {
        if (child.kind === 'assign' && child.left?.kind === 'variable') {
          const cls = child.right?.kind === 'new' ? resolveClass(child.right.what,item.context,item.className) : child.right?.kind === 'variable' ? variables.get(name(child.right)) : undefined;
          if (cls && !conditionalVariables.has(name(child.left))) variables.set(name(child.left),cls); else variables.delete(name(child.left));
        }
        if (child.kind !== 'call' || !['propertylookup','staticlookup'].includes(child.what?.kind)) return;
        const lookup = child.what, method = name(lookup.offset);
        if (!method) return;
        if (lookup.offset?.kind !== 'identifier') { calls.push({method:'动态方法',site:span(item.file,lookup.offset),reason:'方法名由运行时表达式确定'}); return; }
        let className: string | undefined;
        if (lookup.kind === 'staticlookup') {
          className = resolveClass(lookup.what,item.context,item.className);
          const facade = className && facades.get(className.toLowerCase());
          if (facade) {
            const visibility = facade.methods.get(method.toLowerCase());
            const own = visibility && (visibility === 'public' || className?.toLowerCase() === item.className.toLowerCase());
            if (!own) className = facade.methods.has('__callstatic') ? undefined : facade.target;
          }
        }
        else if (lookup.what?.kind === 'variable') className = name(lookup.what) === 'this' ? item.className : variables.get(name(lookup.what));
        else if (lookup.what?.kind === 'propertylookup' && name(lookup.what.what) === 'this') className = properties.get(name(lookup.what.offset));
        else if (lookup.what?.kind === 'new') className = resolveClass(lookup.what.what,item.context,item.className);
        calls.push({ className,method,site:span(item.file,lookup.offset),...(className?{}:{reason:'动态接收者或缺少可静态确定的类型'}) });
      });
      result.methods.push({node,className:item.className,name:methodName,calls});
    }
  }
  return result;
}
