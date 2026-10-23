const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Worker}=require('node:worker_threads');
const path=require('node:path');
const {defaults}=require('../out/types');
test('打包后的 Worker 不依赖 node_modules 动态相对路径，可直接分析源码',async()=>{
 const result=await new Promise((resolve,reject)=>{
  const worker=new Worker(path.resolve(__dirname,'../dist/worker.js'),{workerData:{files:[],root:'/p',options:defaults}});
  worker.once('message',resolve);worker.once('error',reject);
 });
 assert.ok(!result.error);
 assert.ok(Array.isArray(result.nodes));
});
