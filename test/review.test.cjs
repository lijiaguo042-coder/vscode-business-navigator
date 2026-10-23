const test = require('node:test');
const assert = require('node:assert/strict');
const {analyzeFrontend}=require('../out/frontend');
const {buildIndex}=require('../out/index');
const {defaults}=require('../out/types');
test('review: namespace import 被参数遮蔽时不关联 API',()=>{
 const file='/p/resources/js/views/a.js';
 const source="import * as api from '../api/a'; export function run(api){ api.list(); }";
 const result=analyzeFrontend(new Map([
 [file,source],['/p/resources/js/api/a.js','export function list(){}'],
 ]),'/p',defaults);
 const offset=source.indexOf('api.list')+4;
 assert.equal(result.edges.filter(edge=>edge.site.file===file&&edge.site.start<=offset&&edge.site.end>offset).length,0);
});
test('review: computed 属性不应按标识符名称推断 API',()=>{
 const file='/p/resources/js/views/a.js';
 const source="import * as api from '../api/a'; export function run(list){ api[list](); }";
 const result=analyzeFrontend(new Map([[file,source],['/p/resources/js/api/a.js','export function list(){}']]),'/p',defaults);
 const offset=source.lastIndexOf('list');
 assert.equal(result.edges.filter(edge=>edge.site.file===file&&edge.site.start<=offset&&edge.site.end>offset).length,0);
});
test('review: PHP 内层调用跳转不夹带外层调用目标',()=>{
 const file='/p/app/Http/Controllers/Demo.php';
 const source='<?php namespace App\\Http\\Controllers; class Demo { function run(){ $this->wrap($this->inner()); } function wrap($value){} function inner(){} }';
 const graph=buildIndex(new Map([[file,source]]),'/p',{...defaults,routeEntrypoints:[]});
 assert.deepEqual(graph.definitions(file,source.indexOf('inner()')).map(node=>node.label),['Demo::inner']);
});
test('review: Resource 直接实例按各自 URI 展开且不依赖文件顺序',()=>{
 const resource="import request from '../utils/request'; class Resource { constructor(uri){this.uri=uri;} list(){ return request({url:'/'+this.uri,method:'get'}); } } export {Resource as default};";
 const entries=[
 ['/p/resources/js/api/resource.js',resource],
 ['/p/resources/js/utils/request.js','export default function request(){}'],
 ['/p/resources/js/views/a.js',"import Resource from '../api/resource'; const roles=new Resource('roles'); const users=new Resource('users'); export function load(){roles.list();users.list();}"],
 ];
 for(const files of [new Map(entries),new Map([...entries].reverse())]){
 const result=analyzeFrontend(files,'/p',defaults);
 assert.deepEqual(result.endpoints.map(endpoint=>endpoint.path).sort(),['/roles','/users']);
 }
});
