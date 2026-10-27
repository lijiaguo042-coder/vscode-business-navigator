# 服务与 Facade 实现导航

## 问题与目标

`FreezeBuYuService` 中的 `GameUtils::getBanList(...)` 导入的是 Laravel Facade，实际实现在 `App\Utils\GameUtils`。0.1.1 仅对控制器调用建边，也没有解析 Facade 的容器绑定，因此无法定位实现。

## 设计

复用 PHP AST、namespace/use 解析和同一关系图，让工作区应用类中可确定的方法调用都参与定义、侧栏和反向引用。每个方法只记录直接调用，侧栏按用户展开逐层浏览，现有循环检测继续生效。

识别直接继承 Laravel Facade 的类，要求 `getFacadeAccessor()` 是单一静态 return。支持返回实现类的 `::class`，或者容器键；容器键从直接继承 Laravel ServiceProvider 的工作区类的 `register()` / `boot()` 中提取 `$this->app->singleton()`、`bind()`。绑定目标支持类名常量、完整类名字符串、仅含 `return new Concrete` 的闭包。

Facade 自身可访问的方法优先；外部调用受保护方法时仍按转发处理。同一键出现不同目标、未知目标或条件绑定时，不选择任意一个目标。只接受生命周期方法直线语句前缀中的绑定，遇到分支或提前退出后不将后续绑定视为确定。自定义 `__callStatic` 的 Facade 不推断缺失方法的转发目标；动态绑定键会保守停用 Facade 转发推断。

容器注册和 PHP 文件都不执行，不读取 `.env`，不按 Facade 类名或注释中的方法名猜测实现。

## 实施计划

1. `test/facade.test.cjs`：真实语义夹具覆盖服务到工具类、Facade 到实现、反向引用、循环、冲突和动态边界。先运行并确认缺失能力的测试失败。
2. `src/index.ts`：移除仅控制器建边的限制；保留现有未解析标记。
3. `src/php.ts`：复用 `value` / `resolveClass`，收集明确容器绑定和 Facade 映射，在静态调用解析处应用映射。
4. `scripts/test-host.cjs` / `test/host/index.cjs`：增加隔离 Facade、容器绑定、服务调用夹具，验证 F12 打开实现及反向引用。
5. 更新 README 和版本 0.1.2；使用 Node 24 构建、运行完整测试、只读检查真实项目并生成 VSIX。

## 边界

只分析扫描范围内声明的静态绑定候选，不模拟 ServiceProvider 的运行时加载、覆盖顺序、条件或容器替换。继承 / Trait 方法、Facade 中间父类、自定义工厂、复杂闭包、容器别名和其他注册 API 不在本次支持范围。

未确定的目标继续显示未解析。其他 PHP 语言插件也可能返回注释声明，VS Code / Cursor 会合并多插件候选；本插件新增的是实际方法实现目标，不控制其他插件的结果。

## 验证记录

- 使用 Node 24 构建，TypeScript 类型检查通过；完整自动化测试 31 项全部通过。
- 新增能力在实现前复现失败；动态属性、提前退出、自定义魔术调用及非公开方法的边界已补充回归用例，并完成只读代码复核。
- 只读使用 `operator-admin-platform` 当前源码构建索引，`FreezeBuYuService::freezeRecord` 内的 `GameUtils::getBanList` 定位 `app/Utils/GameUtils.php:129`，实现方法的反向引用包含原服务调用位置。业务项目未修改。
- VS Code 和 Cursor 的隔离真实宿主测试均通过，退出码为 0。验证默认路由及控制器切换、服务中 Facade 的定义提供者与 F12 打开真实实现、反向引用追溯 Vue 页面、未保存绑定修改后的新实现定位、丢弃修改后恢复原实现，以及原有编辑 / 重命名场景。
- 宿主测试使用临时项目、用户配置和扩展目录，不将隔离环境结果等同于用户全部扩展组合的兼容性结论。物理 Cmd+鼠标点击未独立交互验收。

交付版本为 0.1.2，通过 `npm run package` 生成 VSIX。
