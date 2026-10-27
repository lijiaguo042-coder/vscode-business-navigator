const {test} = require('node:test');
const assert = require('node:assert/strict');
const {buildIndex} = require('../out/index');
const {defaults} = require('../out/types');
const fixture = new Map([
 ['/p/jsconfig.json','{"compilerOptions":{"paths":{"@/*":["resources/js/*"]}}}'],
 ['/p/resources/js/utils/request.js','export default function request(){}'],
 ['/p/resources/js/api/items.js',"import request from '@/utils/request'; export function list(){return request({url:'/items',method:'get'});} export function save(){return request({url:'/items',method:'post'});}"],
 ['/p/resources/js/views/A.vue',"<script>import {list} from '@/api/items';export default {methods:{load(){list();}}}</script>"],
 ['/p/routes/api.php',"<?php Route::group(['prefix'=>'api','namespace'=>'App\\Http\\Controllers'], function(){Route::get('items','ItemsController@index'); Route::post('items','ItemsController@store');});"],
 ['/p/app/Http/Controllers/ItemsController.php', '<?php namespace App\\Http\\Controllers; use App\\Services\\ItemService; class ItemsController { private $service; public function __construct(ItemService $s){$this->service=$s;} public function index(){$this->service->list();} public function store(){} }'],
 ['/p/app/Services/ItemService.php', '<?php namespace App\\Services; class ItemService { public function list(){} }'],
]);
const opts={...defaults,routeEntrypoints:['routes/api.php']};
test('const 前缀拼接的相对 URL 能定位控制器，外部地址不参与本地匹配',()=>{
 const file='/p/resources/js/api/items.js';
 const files=new Map(fixture);
 files.set('/p/routes/api.php',files.get('/p/routes/api.php').replaceAll("'items'","'admin/items'"));
 for(const base of ['/api','https://example.com/api/']){
  for(const url of ["PREFIX + '/items'","'/admin/items'","'https://example.com/admin/items'","'//example.com/admin/items'","'ftp://example.com/admin/items'"]){
   const source=`import request from '@/utils/request'; const PREFIX='admin'; export function list(){return request({url:${url},method:'get'});}`;
   files.set(file,source);
   const graph=buildIndex(files,'/p',{...opts,requestBasePath:base});
   const defs=graph.definitions(file,source.indexOf(url)+2,'controller');
   assert.deepEqual(defs.map(node=>node.label),url.startsWith('PREFIX')||url==="'/admin/items'"?['ItemsController::index']:[],`${base}: ${url}`);
  }
 }
});
test('URL 默认定位路由，可选择控制器，路由处理器和服务仍定位方法',()=>{
 const graph=buildIndex(fixture,'/p',opts);
 const file='/p/resources/js/api/items.js';
 const pos=fixture.get(file).indexOf("'/items'")+2;
 const routes=graph.definitions(file,pos);
 assert.deepEqual(routes.map(node=>node.label),['GET|HEAD /api/items']);
 const route=routes[0];
 const handler=fixture.get(route.file).indexOf('ItemsController@index')+2;
 for(const mode of ['route','controller']){
  assert.deepEqual(graph.definitions(route.file,handler,mode).map(node=>node.label),['ItemsController::index']);
  const controllerFile='/p/app/Http/Controllers/ItemsController.php';
  assert.deepEqual(graph.definitions(controllerFile,fixture.get(controllerFile).indexOf('->list')+2,mode).map(node=>node.label),['ItemService::list']);
 }
 const files=new Map(fixture);
 files.delete('/p/app/Http/Controllers/ItemsController.php');
 const missing=buildIndex(files,'/p',opts);
 assert.equal(missing.definitions(file,pos)[0].kind,'route');
 assert.deepEqual(missing.definitions(file,pos,'controller'),[]);
});
test('URL 定义按方法定位控制器，侧栏完整链路和反向页面调用共用同一索引',()=>{
 const graph=buildIndex(fixture,'/p',opts);
 const file='/p/resources/js/api/items.js';
 const pos=fixture.get(file).indexOf("'/items'")+2;
 const defs=graph.definitions(file,pos,'controller');
 assert.equal(defs.length,1);
 assert.match(defs[0].label,/index/);
 const api=graph.nodeAt(file,pos);
 const route=graph.outgoing(api.id).find(n=>n.kind==='route');
 assert.ok(route);
 const controller=graph.outgoing(route.id).find(n=>n.kind==='controller');
 assert.ok(graph.outgoing(controller.id).some(n=>n.kind==='service' && /list/.test(n.label)));
 assert.ok(graph.references(controller.id).some(s=>s.file.endsWith('A.vue')));
});
test('基础路径配置、重复候选、重建后删除和解析错误隔离',()=>{
 const files=new Map(fixture);
 files.set('/p/routes/api.php',files.get('/p/routes/api.php').replace("Route::get('items','ItemsController@index');","Route::get('items','ItemsController@index');Route::get('items','ItemsController@store');"));
 files.set('/p/resources/js/api/bad.js','export function {');
 const graph=buildIndex(files,'/p',opts);
 const file='/p/resources/js/api/items.js',pos=files.get(file).indexOf("'/items'")+2;
 assert.equal(graph.definitions(file,pos).length,2);
 assert.equal(graph.errors.length,1);
 assert.equal(buildIndex(files,'/p',{...opts,requestBasePath:'/other'}).definitions(file,pos).length,0);
 files.delete('/p/routes/api.php');
 assert.equal(buildIndex(files,'/p',opts).definitions(file,pos).length,0);
});
