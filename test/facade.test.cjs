const {test} = require('node:test');
const assert = require('node:assert/strict');
const {buildIndex} = require('../out/index');
const {defaults} = require('../out/types');

const serviceFile = '/p/app/Services/FreezeService.php';
const facadeFile = '/p/app/Utils/Facades/GameUtils.php';
const providerFile = '/p/app/Providers/AppServiceProvider.php';
const implementationFile = '/p/app/Utils/GameUtils.php';
const fixture = new Map([
  [serviceFile, '<?php namespace App\\Services; use App\\Utils\\Facades\\GameUtils as Games; class FreezeService { public function run(){ Games::getBanList(); } }'],
  [facadeFile, "<?php namespace App\\Utils\\Facades; use Illuminate\\Support\\Facades\\Facade; /** @method static getBanList() */ class GameUtils extends Facade { protected static function getFacadeAccessor(){ return 'game-utils'; } public static function own(){} }"],
  [providerFile, "<?php namespace App\\Providers; use Illuminate\\Support\\ServiceProvider; use App\\Utils\\GameUtils as Implementation; class AppServiceProvider extends ServiceProvider { public function boot(){ $this->app->singleton('game-utils', function(){ return new Implementation; }); } }"],
  [implementationFile, '<?php namespace App\\Utils; class GameUtils { public function getBanList(){ $this->helper(); } public function helper(){ $this->getBanList(); } public function own(){} }'],
]);
const options = {...defaults, routeEntrypoints: []};

test('服务中的 Facade 调用通过 singleton 绑定定位真实实现并保留反向引用', () => {
  const graph = buildIndex(fixture, '/p', options);
  const offset = fixture.get(serviceFile).indexOf('getBanList') + 2;
  const definitions = graph.definitions(serviceFile, offset);
  assert.deepEqual(definitions.map(node => node.detail), ['App\\Utils\\GameUtils']);
  assert.equal(definitions[0].file, implementationFile);
  assert.equal(fixture.get(implementationFile).slice(definitions[0].start, definitions[0].start + 15), 'public function');
  assert.ok(graph.references(definitions[0].id).some(site => site.file === serviceFile && site.start < offset && site.end > offset));
});

test('服务及工具类内部调用可以连续定位，循环引用能够结束遍历', () => {
  const graph = buildIndex(fixture, '/p', options);
  const offset = fixture.get(implementationFile).indexOf('->helper') + 3;
  const definitions = graph.definitions(implementationFile, offset);
  assert.deepEqual(definitions.map(node => node.label), ['GameUtils::helper']);
  assert.ok(graph.references(definitions[0].id).length > 0);
});

test('Facade 支持明确的类 accessor、类常量和完整类名字符串绑定，自身方法优先', () => {
  for (const binding of ["$this->app->bind('game-utils', Implementation::class);", "$this->app->singleton('game-utils', '\\\\App\\\\Utils\\\\GameUtils');"]) {
    const files = new Map(fixture);
    files.set(providerFile, files.get(providerFile).replace("$this->app->singleton('game-utils', function(){ return new Implementation; });", binding));
    const graph = buildIndex(files, '/p', options);
    assert.equal(graph.definitions(serviceFile, files.get(serviceFile).indexOf('getBanList') + 2)[0]?.file, implementationFile, binding);
  }
  const files = new Map(fixture);
  files.delete(providerFile);
  files.set(facadeFile, files.get(facadeFile).replace("'game-utils'", '\\App\\Utils\\GameUtils::class'));
  files.set(serviceFile, files.get(serviceFile).replace('Games::getBanList();', 'Games::getBanList(); Games::own();'));
  const graph = buildIndex(files, '/p', options);
  assert.equal(graph.definitions(serviceFile, files.get(serviceFile).indexOf('getBanList') + 2)[0]?.file, implementationFile);
  assert.equal(graph.definitions(serviceFile, files.get(serviceFile).indexOf('::own') + 3)[0]?.file, facadeFile);
});

test('动态、条件或冲突绑定保持未解析，不凭同名类和注释猜测目标', () => {
  const original = "$this->app->singleton('game-utils', function(){ return new Implementation; });";
  for (const replacement of [
    '',
    "$this->app->singleton('game-utils', function(){ return makeImplementation(); });",
    "if ($flag) { $this->app->singleton('game-utils', Implementation::class); }",
    original + " $this->app->bind('game-utils', Other::class);",
    original + " if ($flag) { $this->app->bind('game-utils', Other::class); }",
    original + " $this->app->bind('game-utils', resolveImplementation());",
    "$this->$app->singleton('game-utils', Implementation::class);",
    original + " $this->app->bind($runtimeKey, Implementation::class);",
    'if (!$enabled) { return; } ' + original,
    'return; ' + original,
    "$this->app->bind('game-utils', Implementation::$class);",
  ]) {
    const files = new Map(fixture);
    files.set(providerFile, files.get(providerFile).replace(original, replacement));
    const graph = buildIndex(files, '/p', options);
    assert.deepEqual(graph.definitions(serviceFile, files.get(serviceFile).indexOf('getBanList') + 2), [], replacement);
  }
  const files = new Map(fixture);
  files.set(facadeFile, files.get(facadeFile).replace("return 'game-utils';", "return config('facade');"));
  assert.deepEqual(buildIndex(files, '/p', options).definitions(serviceFile, files.get(serviceFile).indexOf('getBanList') + 2), []);
});

test('自定义 Facade 魔术调用与动态 class 属性不推断为实现类', () => {
  for (const source of [
    fixture.get(facadeFile).replace('public static function own(){}', 'public static function own(){} public static function __callStatic($method, $args){return false;}'),
    fixture.get(facadeFile).replace("'game-utils'", '\\App\\Utils\\GameUtils::$class'),
  ]) {
    const files = new Map(fixture);
    files.set(facadeFile, source);
    assert.deepEqual(buildIndex(files, '/p', options).definitions(serviceFile, files.get(serviceFile).indexOf('getBanList') + 2), []);
  }
});

test('外部调用 Facade 非公开方法时转发到实现，Facade 内部仍可调用自身方法', () => {
  const files = new Map(fixture);
  files.set(facadeFile, files.get(facadeFile).replace('public static function own(){}', 'protected static function own(){} public static function internal(){self::own();}'));
  files.set(serviceFile, files.get(serviceFile).replace('Games::getBanList()', 'Games::own()'));
  const graph = buildIndex(files, '/p', options);
  assert.equal(graph.definitions(serviceFile, files.get(serviceFile).indexOf('::own') + 3)[0]?.file, implementationFile);
  assert.equal(graph.definitions(facadeFile, files.get(facadeFile).indexOf('self::own') + 7)[0]?.file, facadeFile);
});
