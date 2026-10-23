const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {collectSources}=require('../out/workspace');
const {defaults}=require('../out/types');
test('扫描遵循目录配置、PSR-4、强制排除、符号链接和未保存内容覆盖',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'business-nav-'));
 try{
  await fs.mkdir(path.join(root,'app'),{recursive:true});
  await fs.mkdir(path.join(root,'extra'),{recursive:true});
  await fs.mkdir(path.join(root,'app/node_modules'),{recursive:true});
  await fs.writeFile(path.join(root,'app/a.php'),'<?php class A {}');
  await fs.writeFile(path.join(root,'extra/b.php'),'<?php class B {}');
  await fs.writeFile(path.join(root,'app/node_modules/bad.js'),'invalid');
  await fs.symlink(path.join(root,'extra/b.php'),path.join(root,'app/link.php'));
  await fs.writeFile(path.join(root,'composer.json'),JSON.stringify({autoload:{'psr-4':{'Extra\\':'extra/'}}}));
  const files=await collectSources(root,{...defaults,sourceRoots:['app'],exclude:[]},new Map([[path.join(root,'app/a.php'),'<?php class Updated {}']]));
  assert.equal(files.get(path.join(root,'app/a.php')),'<?php class Updated {}');
  assert.ok(files.has(path.join(root,'extra/b.php')));
  assert.ok(!files.has(path.join(root,'app/link.php')));
  assert.ok(![...files.keys()].some(p=>p.includes('node_modules')));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
