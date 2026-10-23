const {runTests} = require('@vscode/test-electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

/** 在临时配置和临时项目内启动本机 VS Code，避免改动用户编辑器设置。 */
async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'business-nav-host-'));
  const fixture = path.join(temporary, 'fixture');
  const sources = {
    'jsconfig.json': '{"compilerOptions":{"paths":{"@/*":["resources/js/*"]}}}',
    'resources/js/utils/request.js': 'export default function request(){}',
    'resources/js/api/items.js': "import request from '@/utils/request';\nexport function list(){\n  return request({\n    url:'/items',\n    method:'get'\n  });\n}",
    'resources/js/views/A.vue': "<template><div/></template><script>import {list} from '@/api/items'; export default {methods:{load(){list();}}};</script>",
    'app/Providers/RouteServiceProvider.php': "<?php namespace App\\Providers; class RouteServiceProvider {protected $namespace='App\\Http\\Controllers'; public function map(){ $this->mapApi(); } protected function mapApi(){\\Route::prefix('api')->namespace($this->namespace)->group(base_path('routes/api.php'));}}",
    'routes/api.php': "<?php Route::get('items','ItemsController@index');",
    'app/Http/Controllers/ItemsController.php': '<?php namespace App\\Http\\Controllers; use App\\Services\\ItemService; class ItemsController {private $service; public function __construct(ItemService $s){$this->service=$s;} public function index(){$this->service->list();}}',
    'app/Services/ItemService.php': '<?php namespace App\\Services; class ItemService { public function list(){} }',
  };
  for (const [name, text] of Object.entries(sources)) {
    const file = path.join(fixture, name); await fs.mkdir(path.dirname(file), {recursive:true}); await fs.writeFile(file,text);
  }
  const companion=path.join(temporary,'companion'); await fs.mkdir(companion);
  const workspace=path.join(temporary,'test.code-workspace');
  await fs.writeFile(workspace,JSON.stringify({folders:[{path:fixture},{path:companion}]}));
  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
      extensionDevelopmentPath: path.resolve(__dirname,'..'),
      extensionTestsPath: path.resolve(__dirname,'../test/host/index.cjs'),
      launchArgs:[workspace,'--user-data-dir',path.join(temporary,'profile'),'--extensions-dir',process.env.BUSINESS_NAV_EXTENSIONS_DIR ?? path.join(temporary,'extensions'),'--disable-gpu','--skip-welcome','--skip-release-notes','--disable-workspace-trust'],
    });
  } finally { await fs.rm(temporary,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
