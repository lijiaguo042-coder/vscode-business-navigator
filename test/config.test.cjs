const {test} = require('node:test');
const assert = require('node:assert/strict');
const {buildIndex} = require('../out/index');
const {defaults} = require('../out/types');
const file = '/p/app/Services/Demo.php';
const configFile = '/p/config/application.php';
const fixture = new Map([
  [file, "<?php namespace App\\Services; class Demo {function run(){return config('application.upload_zipfile_v2');}}"],
  [configFile, "<?php return ['upload_zipfile_v2'=>['enabled'=>true], 'other'=>env('SECRET_VALUE')];"],
]);
const options = {...defaults, routeEntrypoints: []};

test('config 静态键定位配置数组键名，配置反向引用包含调用位置', () => {
  const graph = buildIndex(fixture, '/p', options);
  const offset = fixture.get(file).indexOf('application.upload_zipfile_v2') + 15;
  const definitions = graph.definitions(file, offset);
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].file, configFile);
  assert.equal(definitions[0].kind, 'config');
  assert.equal(fixture.get(configFile).slice(definitions[0].start, definitions[0].end), "'upload_zipfile_v2'");
  assert.ok(graph.references(definitions[0].id).some(site => site.file === file && site.start <= offset && site.end > offset));
});

test('顶层全局调用、函数别名、静态拼接及多级键都可跳转，配置名可打开文件', () => {
  for (const source of [
    "<?php \\config('application.upload_zipfile_v2.enabled');",
    "<?php use function \\config as settings; settings('application.upload_zipfile_v2.enabled');",
    "<?php config('application.' . 'upload_zipfile_v2.enabled');",
  ]) {
    const files = new Map(fixture);
    files.set(file, source);
    const graph = buildIndex(files, '/p', options);
    const definitions = graph.definitions(file, source.indexOf('application.') + 3);
    assert.equal(definitions[0]?.file, configFile, source);
    assert.equal(files.get(configFile).slice(definitions[0].start, definitions[0].end), "'enabled'");
  }
  const files = new Map(fixture);
  files.set(file, "<?php config('application');");
  assert.equal(buildIndex(files, '/p', options).definitions(file, 17)[0]?.file, configFile);
});

test('动态和缺失配置、setter、同名方法与自定义函数不产生错误跳转', () => {
  for (const source of [
    "<?php config('application.missing');",
    "<?php config($key);",
    "<?php config(['application.upload_zipfile_v2'=>true]);",
    "<?php $obj->config('application.upload_zipfile_v2');",
    "<?php namespace App; function config($key){} config('application.upload_zipfile_v2');",
    "<?php use function Other\\config; config('application.upload_zipfile_v2');",
    "<?php Other\\config('application.upload_zipfile_v2');",
    "<?php namespace App; namespace\\config('application.upload_zipfile_v2');",
    "<?php namespace App; if($flag){function config($key){}} config('application.upload_zipfile_v2');",
    "<?php namespace App; function install(){function config($key){}} install(); config('application.upload_zipfile_v2');",
    "<?php config('missing.upload_zipfile_v2');",
  ]) {
    const files = new Map(fixture);
    files.set(file, source);
    const graph = buildIndex(files, '/p', options);
    assert.deepEqual(graph.definitions(file, source.lastIndexOf('application.') + 3), [], source);
  }
});

test('动态返回和动态数组键不猜测，语法错误配置文件隔离且不泄露内容', () => {
  for (const source of [
    "<?php return makeConfig();",
    "<?php return ['upload_zipfile_v2'=>true, $key=>false];",
    "<?php if($flag){return ['upload_zipfile_v2'=>false];} return ['upload_zipfile_v2'=>true];",
    "<?php $password='SECRET_EXAMPLE'; return [ ;",
  ]) {
    const files = new Map(fixture);
    files.set(configFile, source);
    const graph = buildIndex(files, '/p', options);
    assert.deepEqual(graph.definitions(file, files.get(file).indexOf('application.') + 3), [], source);
    assert.ok(!JSON.stringify(graph.errors).includes('SECRET_EXAMPLE'));
  }
});
