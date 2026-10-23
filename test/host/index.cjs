const vscode = require('vscode');
const assert = require('node:assert/strict');
const path = require('node:path');
/** 通过真实扩展宿主执行导航、引用、侧栏和编辑失效验收。 */
exports.run=async function run(){
 const root=vscode.workspace.workspaceFolders[0].uri.fsPath;
 const uri=name=>vscode.Uri.file(path.join(root,name));
 const extension=vscode.extensions.getExtension('local-tools.vscode-business-navigator');
 assert.ok(extension,'插件必须发现'); await extension.activate();
 const vueDoc=await vscode.workspace.openTextDocument(uri('resources/js/views/A.vue'));
 assert.equal(vueDoc.languageId,'vue','无第三方插件时 Vue 文件也应注册为 vue 语言');
 const vuePos=vueDoc.positionAt(vueDoc.getText().indexOf('list();')+1);
 const vueDefs=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',vueDoc.uri,vuePos);
 assert.ok(vueDefs.some(d=>(d.uri??d.targetUri).fsPath.endsWith('api/items.js')),'Vue 调用应跳转 API');
 if(process.env.BUSINESS_NAV_EXTENSIONS_DIR){
   for(const id of ['bmewburn.vscode-intelephense-client','octref.vetur']){
     const companion=vscode.extensions.getExtension(id);assert.ok(companion,`兼容插件 ${id} 必须安装`);await companion.activate();assert.ok(companion.isActive);
   }
   console.log('HOST: Intelephense + Vetur activated alongside navigator');
 }
 const api=await vscode.workspace.openTextDocument(uri('resources/js/api/items.js'));
 const editor=await vscode.window.showTextDocument(api);
 const pos=api.positionAt(api.getText().indexOf("'/items'")+2);
 editor.selection=new vscode.Selection(pos,pos);
 let defs=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',api.uri,pos);
 assert.ok(defs.some(d=>(d.uri??d.targetUri).fsPath.endsWith('ItemsController.php')),'URL 必须定位控制器');console.log('HOST: URL definitions passed');
 await vscode.commands.executeCommand('businessNavigator.showChain');
 if(process.env.BUSINESS_NAV_PREVIEW){
   console.log('HOST PREVIEW: 90 秒交互验收窗口');
   await new Promise(resolve=>setTimeout(resolve,90000));
   await vscode.window.showTextDocument(api);editor.selection=new vscode.Selection(pos,pos);
 }
 await vscode.commands.executeCommand('businessNavigator.togglePin');
 await vscode.commands.executeCommand('businessNavigator.togglePin');
 await vscode.commands.executeCommand('editor.action.revealDefinition');
 assert.ok(vscode.window.activeTextEditor.document.uri.fsPath.endsWith('ItemsController.php'),'F12 命令必须打开控制器');
 const controller=await vscode.workspace.openTextDocument(uri('app/Http/Controllers/ItemsController.php'));
 const methodPos=controller.positionAt(controller.getText().indexOf('function index')+'function '.length);
 const refs=await vscode.commands.executeCommand('vscode.executeReferenceProvider',controller.uri,methodPos);
 assert.ok(refs.some(r=>r.uri.fsPath.endsWith('A.vue')),'反向引用应包括 Vue 实际调用');
 const servicePos=controller.positionAt(controller.getText().indexOf('->list')+3);
 defs=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',controller.uri,servicePos);
 assert.ok(defs.some(d=>(d.uri??d.targetUri).fsPath.endsWith('ItemService.php')),'注入服务方法应可跳转');console.log('HOST: F12, references and service passed');
 await vscode.window.showTextDocument(api);
 const edit=new vscode.WorkspaceEdit(); edit.replace(api.uri,new vscode.Range(api.positionAt(0),api.positionAt(api.getText().length)),api.getText().replace('/items','/missing'));
 await vscode.workspace.applyEdit(edit);
 defs=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',api.uri,pos);
 assert.equal(defs.length,0,'未保存编辑不能保留旧路由');
 await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
 const reopened=await vscode.workspace.openTextDocument(api.uri);
 await vscode.window.showTextDocument(reopened);
 defs=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',api.uri,pos);
 assert.ok(defs.length>0,'关闭并丢弃未保存内容后自动恢复磁盘索引');
 await vscode.commands.executeCommand('businessNavigator.rebuild');
 defs=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',api.uri,pos);
 assert.ok(defs.length>0,'恢复源码后可重建');console.log('HOST: edit/discard/rebuild passed');
 const foldersChanged=new Promise(resolve=>{const listener=vscode.workspace.onDidChangeWorkspaceFolders(()=>{listener.dispose();resolve();});});
 vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders.length,0,{uri:uri('routes')});
 await foldersChanged;
 const routeDoc=await vscode.workspace.openTextDocument(uri('routes/api.php'));
 const nestedEdit=new vscode.WorkspaceEdit();nestedEdit.replace(routeDoc.uri,new vscode.Range(routeDoc.positionAt(0),routeDoc.positionAt(routeDoc.getText().length)),"<?php Route::post('items','ItemsController@index');");
 await vscode.workspace.applyEdit(nestedEdit);
 defs=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',api.uri,pos);
 assert.equal(defs.length,0,'嵌套工作区内编辑同时失效父索引');
 // 恢复路由，继续验证文件重命名。
 const restore=new vscode.WorkspaceEdit();restore.replace(routeDoc.uri,new vscode.Range(routeDoc.positionAt(0),routeDoc.positionAt(routeDoc.getText().length)),"<?php Route::get('items','ItemsController@index');");
 await vscode.workspace.applyEdit(restore);await routeDoc.save();
 const rename=new vscode.WorkspaceEdit();rename.renameFile(uri('routes/api.php'),uri('routes/renamed.php'));
 await vscode.workspace.applyEdit(rename);await vscode.commands.executeCommand('businessNavigator.rebuild');
 defs=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',api.uri,pos);
 assert.equal(defs.length,0,'路由文件重命名后失效');
 console.log('HOST PASS: 定义、F12命令、服务、Vue反向引用、侧栏命令、固定、未保存编辑和重命名');
};
