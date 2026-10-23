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
test('URL 定义按方法定位控制器，侧栏完整链路和反向页面调用共用同一索引',()=>{
 const graph=buildIndex(fixture,'/p',opts);
 const file='/p/resources/js/api/items.js';
 const pos=fixture.get(file).indexOf("'/items'")+2;
 const defs=graph.definitions(file,pos);
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
