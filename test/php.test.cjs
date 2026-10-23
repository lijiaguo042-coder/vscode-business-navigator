const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzePhp } = require('../out/php.js');
const root = '/example';
/** 构造绝对路径源码映射。 */
function analyze(sources) {
  return analyzePhp(new Map(Object.entries(sources).map(([file, source]) => [`${root}/${file}`, source])), root, ['app/Providers/RouteServiceProvider.php']);
}
test('只从 provider map 可达方法加载路由并保留分组和处理器范围', () => {
  const route = `<?php Route::group(['prefix'=>'privacy','namespace'=>'Admin'], function () { Route::post('approve', 'PrivacyController@approve'); });`;
  const result = analyze({
    'app/Providers/RouteServiceProvider.php': `<?php namespace App\\Providers; use Illuminate\\Support\\Facades\\Route; class RouteServiceProvider { protected $namespace='App\\Http\\Controllers'; function map(){ $this->mapApi(); } function mapApi(){ Route::prefix('api')->namespace($this->namespace)->group(base_path('routes/api.php')); } function unused(){ Route::group([], base_path('routes/unloaded.php')); } }`,
    'routes/api.php': route,
    'routes/unloaded.php': `<?php Route::get('wrong', 'Wrong@index');`,
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.routes.length, 1);
  assert.equal(result.routes[0].path, '/api/privacy/approve');
  assert.equal(result.routes[0].controller, 'App\\Http\\Controllers\\Admin\\PrivacyController');
  assert.equal(route.slice(result.routes[0].handler.start, result.routes[0].handler.end), "'PrivacyController@approve'");
});
test('资源路由 only except 和嵌套资源参数符合 Laravel 约定', () => {
  const result = analyze({
    'app/Providers/RouteServiceProvider.php': `<?php Route::namespace('App\\Http\\Controllers')->group(base_path('routes/api.php'));`,
    'routes/api.php': `<?php Route::resource('photos.comments', 'CommentController')->only(['index','show','update'])->except('update'); Route::apiResources(['people'=>'PersonController']);`,
  });
  assert.deepEqual(result.routes.slice(0,2).map(r=>[r.methods,r.path,r.action]), [[['GET','HEAD'],'/photos/{photo}/comments','index'],[['GET','HEAD'],'/photos/{photo}/comments/{comment}','show']]);
  assert.ok(result.routes.some(r=>r.path==='/people/{person}' && r.action==='show'));
  assert.ok(!result.routes.some(r=>r.action==='create'));
});
test('解析命名空间别名、构造器注入、局部 new 和静态调用，未知接收者不猜测', () => {
  const result = analyze({
    'app/Providers/RouteServiceProvider.php': '<?php',
    'app/Http/Controllers/PrivacyController.php': `<?php namespace App\\Http\\Controllers; use App\\Services\\PrivacyService as Privacy; use function helper\\run; class PrivacyController { function __construct(Privacy $privacy){$this->privacy=$privacy;} function approve(){ $service=new Privacy(); $service->save(); $this->privacy->notify(); Privacy::check(); $unknown->run(); } }`,
  });
  const method = result.methods.find(m=>m.name==='approve');
  assert.equal(method.className,'App\\Http\\Controllers\\PrivacyController');
  assert.deepEqual(method.calls.map(c=>[c.className,c.method]),[['App\\Services\\PrivacyService','save'],['App\\Services\\PrivacyService','notify'],['App\\Services\\PrivacyService','check'],[undefined,'run']]);
  assert.ok(method.calls[3].reason);
});
test('解析错误不泄露源码或密钥', () => {
  const result = analyze({'app/Providers/RouteServiceProvider.php': `<?php $password = 'SECRET_EXAMPLE'; function broken( {`});
  assert.equal(result.errors.length,1);
  assert.ok(!result.errors[0].message.includes('SECRET_EXAMPLE'));
});
test('独立示例审批路由能够连接控制器和服务调用', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const project = path.join(__dirname, 'fixtures', 'laravel');
  const names = ['app/Providers/RouteServiceProvider.php', 'routes/api.php', 'app/Http/Controllers/Review/Admin/ReviewController.php', 'app/Http/Services/Review/ReviewService.php'];
  const files = new Map(names.map(file => [path.join(project,file),fs.readFileSync(path.join(project,file),'utf8')]));
  const result = analyzePhp(files, project, [names[0]]);
  const route = result.routes.find(route => route.path === '/api/reviews/approve');
  assert.ok(route);
  assert.equal(route.controller, 'App\\Http\\Controllers\\Review\\Admin\\ReviewController');
  const method = result.methods.find(method => method.className === route.controller && method.name === route.action);
  assert.ok(method);
  assert.ok(method.calls.some(call => call.className === 'App\\Http\\Services\\Review\\ReviewService'));
  assert.equal(result.errors.length,0);
});
test('match any class 数组与 fluent group 保留真实动作', () => {
  const result = analyze({
    'app/Providers/RouteServiceProvider.php': `<?php Route::prefix('v1')->group(base_path('routes/api.php'));`,
    'routes/api.php': `<?php use App\\Http\\Controllers\\PrivacyController as Privacy; Route::namespace('Admin')->prefix('tools')->group(function(){ Route::match(['get','post'], 'check', [Privacy::class, 'check']); Route::any('all', '\\App\\Http\\Controllers\\PrivacyController@all'); });`,
  });
  assert.equal(result.routes[0].path,'/v1/tools/check');
  assert.deepEqual(result.routes[0].methods,['GET','POST']);
  assert.equal(result.routes[0].controller,'App\\Http\\Controllers\\PrivacyController');
  assert.equal(result.routes[0].action,'check');
  assert.equal(result.routes[1].controller,'App\\Http\\Controllers\\PrivacyController');
  assert.ok(result.routes[1].methods.includes('OPTIONS'));
});

test('资源 class 常量保持完全限定名，原生类型不会被当成服务类', () => {
  const result = analyze({
    'app/Providers/RouteServiceProvider.php': `<?php Route::namespace('App\\Http\\Controllers')->group(base_path('routes/api.php'));`,
    'routes/api.php': `<?php use App\\Http\\Controllers\\PhotoController; Route::apiResource('photos', PhotoController::class)->only('index','show');`,
    'app/Http/Controllers/Demo.php': `<?php namespace App\\Http\\Controllers; class Demo { function run(string $value){ $value->missing(); } }`,
  });
  assert.equal(result.routes[0].controller,'App\\Http\\Controllers\\PhotoController');
  assert.deepEqual(result.routes.map(route=>route.action),['index','show']);
  assert.equal(result.methods[0].calls[0].className,undefined);
});
test('apiResources 第二参数的 only 和 parameters 生效', () => {
  const result = analyze({
    'app/Providers/RouteServiceProvider.php': `<?php Route::group([], base_path('routes/api.php'));`,
    'routes/api.php': `<?php Route::apiResources(['photos'=>'PhotoController'], ['only'=>['show'], 'parameters'=>['photos'=>'image']]);`,
  });
  assert.deepEqual(result.routes.map(route=>[route.path,route.action]),[['/photos/{image}','show']]);
});
test('self 静态调用解析本类，动态类名和方法名不生成猜测关联', () => {
  const result = analyze({
    'app/Providers/RouteServiceProvider.php': '<?php',
    'app/Http/Controllers/Demo.php': `<?php namespace App\\Http\\Controllers; class Demo { function run(){ self::save(); $cls::save(); $this->$method(); } function save(){} }`,
  });
  const calls = result.methods.find(method=>method.name==='run').calls;
  assert.equal(calls[0].className,'App\\Http\\Controllers\\Demo');
  assert.equal(calls[1].className,undefined);
  assert.equal(calls[2].className,undefined);
  assert.ok(calls[2].reason);
});
test('条件分支内的 new 与注入属性后续重赋值保守保持未解析', () => {
  const result = analyze({
    'app/Providers/RouteServiceProvider.php': '<?php',
    'app/Http/Controllers/Demo.php': `<?php namespace App\\Http\\Controllers; use App\\Services\\First; use App\\Services\\Second; class Demo { function __construct(First $service){$this->service=$service;} function branch($flag){ if($flag){$local=new First();}else{$local=new Second();} $local->save(); } function replace(){ $this->service=new Second(); $this->service->save(); } function later(){ $this->service->save(); } function straight(){ $local=new First(); $local->save(); $local=new Second(); $local->save(); } }`,
  });
  for(const method of ['branch','replace','later']){
    const call=result.methods.find(candidate=>candidate.name===method).calls.find(call=>call.method==='save');
    assert.equal(call.className,undefined);
    assert.ok(call.reason);
  }
  assert.deepEqual(result.methods.find(method=>method.name==='straight').calls.map(call=>call.className),['App\\Services\\First','App\\Services\\Second']);
});
test('构造器条件分支初始化属性也不推断唯一类型', () => {
  const result = analyze({
    'app/Providers/RouteServiceProvider.php': '<?php',
    'app/Http/Controllers/Demo.php': `<?php namespace App\\Http\\Controllers; use App\\Services\\First; use App\\Services\\Second; class Demo { function __construct(First $service,$flag){ if($flag){$this->service=$service;}else{$this->service=new Second();} } function run(){ $this->service->save(); } }`,
  });
  assert.equal(result.methods.find(method=>method.name==='run').calls[0].className,undefined);
});
test('识别全限定全局 Route facade，同时拒绝同名非 Laravel 类', () => {
  const result = analyze({
    'app/Providers/RouteServiceProvider.php': `<?php namespace App\\Providers; use Other\\Route; class RouteServiceProvider { function map(){ \\Route::prefix('api')->group(base_path('routes/api.php')); Route::get('wrong', 'Wrong@index'); } }`,
    'routes/api.php': `<?php use Other\\Route; \\Route::get('good', 'Good@index'); Route::get('wrong', 'Wrong@index');`,
  });
  assert.deepEqual(result.routes.map(route=>route.path),['/api/good']);
});
