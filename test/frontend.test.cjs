const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeFrontend } = require('../out/frontend');
const { defaults } = require('../out/types');

test('Vue 调用关联带别名的 API，保留脚本偏移和 URL 范围', () => {
  const files = new Map([
    ['/p/jsconfig.json', '{"compilerOptions":{"paths":{"@/*":["resources/js/*"]}}}'],
    ['/p/resources/js/utils/request.js', 'export default function request() {}'],
    ['/p/resources/js/api/a.js', "import request from '@/utils/request'; const GROUP='/items'; export function list(){return request({url:GROUP+`/${id}`,method:'GET'});}"],
    ['/p/resources/js/views/A.vue', "<template><div/></template>\n<script>import { list as fetch } from '@/api/a'; export default { methods: { load(){fetch();} } };</script>"],
  ]);
  const result = analyzeFrontend(files, '/p', defaults);
  assert.equal(result.errors.length, 0);
  assert.equal(result.endpoints[0].path, '/items/{dynamic}');
  assert.equal(result.endpoints[0].method, 'GET');
  assert.ok(result.edges.some(e => e.to === result.endpoints[0].node.id && e.site.file.endsWith('A.vue')));
  const call = result.edges.find(e => e.to === result.endpoints[0].node.id && e.site.file.endsWith('A.vue'));
  assert.equal(files.get(call.site.file).slice(call.site.start, call.site.end), 'fetch');
});

test('Resource 继承在不同实例 URI 下展开，关联子类方法和懒加载页面', () => {
  const files = new Map([
    ['/p/resources/js/api/resource.js', "import request from '../utils/request'; export default class Resource { constructor(uri){this.uri=uri;} list(){return request({url:'/'+this.uri,method:'get'});} get(id){return request({url:'/'+this.uri+'/'+id,method:'get'});} }"],
    ['/p/resources/js/api/user.js', "import Resource from './resource'; export default class Users extends Resource { constructor(){super('users');} permissions(id){return request({url:'/'+this.uri+'/'+id+'/permissions',method:'put'});} }"],
    ['/p/resources/js/views/A.vue', "<script>import Users from '../api/user'; const users=new Users(); export default {methods:{load(){users.list();users.permissions(1);}}};</script>"],
    ['/p/resources/js/router/a.js', "export default {component:()=>import('../views/A.vue')}"],
  ]);
  // 子类的请求函数必须明确导入请求封装，不能按函数名猜测。
  files.set('/p/resources/js/api/user.js', "import request from '../utils/request';" + files.get('/p/resources/js/api/user.js'));
  files.set('/p/resources/js/utils/request.js', 'export default function request() {}');
  const result = analyzeFrontend(files, '/p', defaults);
  assert.ok(result.endpoints.some(e => e.path === '/users'));
  assert.ok(result.endpoints.some(e => e.path === '/users/{dynamic}/permissions' && e.method === 'PUT'));
  assert.ok(result.edges.some(e => e.site.file.endsWith('A.vue') && result.endpoints.some(p => p.node.id === e.to && p.path === '/users')));
  assert.ok(result.edges.some(e => e.site.file.endsWith('router/a.js') && result.nodes.some(n => n.id === e.to && n.label === 'A.vue')));
});

test('未知 URL 保持未解析，语法错误隔离，不误认同名 request', () => {
  const result = analyzeFrontend(new Map([
    ['/p/resources/js/api/bad.js', 'export function {'],
    ['/p/resources/js/api/a.js', "import request from '../utils/request'; export function unknown(){return request({url:getUrl(),method:'post'});} export function unrelated(){other({url:'/fake',method:'get'});}"],
    ['/p/resources/js/utils/request.js', 'export default function request() {}'],
  ]), '/p', defaults);
  assert.equal(result.errors.length, 1);
  assert.equal(result.endpoints.length, 1);
  assert.equal(result.endpoints[0].path, undefined);
});
