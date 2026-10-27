# Laravel / Vue 业务链导航

独立 VS Code 扩展，支持 Laravel 5.8 / PHP 7.1 / Vue 2 项目，可通过配置适配相似目录结构。只读取源码，不运行 PHP、Artisan、数据库或业务 HTTP 请求，也不读取 `.env`。

## 安装与使用

要求 VS Code 1.85 或更新版本，Cursor 已通过隔离宿主测试。运行已打包插件不需要安装 Node、PHP 或项目依赖。

1. 从 [GitHub Releases](https://github.com/lijiaguo042-coder/vscode-business-navigator/releases/latest) 下载 **`vscode-business-navigator-0.1.2.vsix`**（不要下载 Source code 源码压缩包作为插件安装）。也可使用 [0.1.2 安装包直链](https://github.com/lijiaguo042-coder/vscode-business-navigator/releases/download/v0.1.2/vscode-business-navigator-0.1.2.vsix)。
2. 在 VS Code 或 Cursor 打开命令面板：macOS 按 **Cmd+Shift+P**，Windows / Linux 按 **Ctrl+Shift+P**，运行 **Extensions: Install from VSIX…**，选择下载的 VSIX。
3. 安装后执行 **Developer: Reload Window**，打开 Laravel / Vue 项目根目录，在 API 的 `url` 表达式上按 F12 验证。

没有显示扩展面板的三点菜单时，也使用上面的命令面板入口。当前通过 GitHub Release 分发，尚未发布到 VS Code Marketplace 或 Open VSX，不能通过扩展商店搜索安装。

也可在下载目录中使用 macOS CLI 安装。

VS Code：

```bash
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension ./vscode-business-navigator-0.1.2.vsix
```

Cursor：

```bash
"/Applications/Cursor.app/Contents/Resources/app/bin/cursor" --install-extension ./vscode-business-navigator-0.1.2.vsix
```

更新时下载新版 VSIX，重复安装并重新加载窗口。VSIX 是安装包，不要直接在终端执行该文件。

- 在 API 的 `url` 表达式上 **Cmd+点击 / F12**，默认先打开 Laravel 路由；继续在路由的控制器字符串上跳转可进入控制器方法。可通过 `apiDefinitionTarget` 改为 URL 直接打开控制器，多个目标使用原生候选列表。
- 在 Resource 实例方法、控制器及服务 / 工具类中的已确定调用上跳转到方法定义。明确的 Laravel Facade 绑定可定位真实实现，例如服务内的 `GameUtils::getBanList(...)`。
- 命令面板运行 **业务链：显示当前代码关联**，或展开资源管理器的 **业务链导航**。树中分别展开上游调用、下游关联，点击节点打开源码。URL 到控制器之间的路由层保留在树中。
- 运行 **业务链：查找关联调用**，或使用原生 **查找所有引用**，查看后端到前端的引用。方法声明上查找最直接；在方法体内选中其他调用时原生引用查询作用于被调用目标。
- 侧栏图钉固定当前编辑器入口，再点一次取消。固定方法删除后显示入口不可用，不自动换成其他方法。
- 文件内容改变、保存、关闭丢弃、创建、删除、重命名会使索引失效。可用 **业务链：重建索引** 手动刷新。第一次使用或重建时显示状态；解析在后台 Worker 中进行，编辑事件防抖 400ms。
- 诊断显示在侧栏及输出面板 **业务链导航**，只记录文件路径、通用原因和行号。

普通 JS 导入和 PHP 语言定义服务继续由已有语言插件提供；本插件只补充能静态确定的关联。多语言插件可能同时返回定义，候选由 VS Code 合并展示。

## 默认配置

在工作区设置中使用 `businessNavigator` 前缀：

| 设置 | 默认值 / 用途 |
| --- | --- |
| `apiDefinitionTarget` | `route`：URL 先跳路由；`controller`：URL 直接跳控制器 |
| `sourceRoots` | `resources/js`、`app`、`routes`；Composer `autoload.psr-4` 工作区内目录自动加入 |
| `routeEntrypoints` | `app/Providers/RouteServiceProvider.php`；也可直接指定路由文件 |
| `requestModules` | `resources/js/utils/request.js`，默认导出的请求函数模块 |
| `requestBasePath` | `/api`；表示请求封装的基础路径，支持填 URL 并取 pathname |
| `exclude` | 额外 glob 排除项；vendor、node_modules、public、storage、.git、插件自身始终排除 |

路径相对于各工作区根目录，不跟随符号链接或读取工作区外路径。`jsconfig.json` 支持 JSONC 注释、`baseUrl` 和 `paths`；未提供时默认识别 `@/* → resources/js/*`。每个工作区独立索引，嵌套工作区内容改变时也会失效包含它的父索引。

`requestBasePath` 必须对应实际 Axios 基础路径；请求 `/privacy-protocol/versions` 默认匹配 `/api/privacy-protocol/versions`。不会为了匹配而任意删除 `/api`。直接写完整外部 URL 的请求不进行本地路由猜测。

相对请求同样支持：`const URL_PREFIX = 'admin'` 与 `URL_PREFIX + '/user-data-query/get-blacklist'` 默认匹配 `/api/admin/user-data-query/get-blacklist`。

在 VS Code 设置中搜索 `businessNavigator.apiDefinitionTarget`，可在下拉框选择两种跳转方式；建议在“工作区”设置中修改。也可在工作区 `.vscode/settings.json` 中设置，修改后下次跳转生效：

```json
{
  "businessNavigator.apiDefinitionTarget": "route"
}
```

改为 `controller` 即可直接跳控制器；此设置不影响查找引用、侧栏和服务方法跳转。

## 支持范围与限制

- JS：直接 import/export、具名再导出、命名空间导入、函数调用、Vue 2 script 和 Router 懒加载页面。
- 请求：已配置模块的默认导入 `request({...})`；字符串、局部 const 拼接、模板字符串、路径动态参数；Resource 基类、固定 `super('users')` 子类和 `new Resource('users')` 实例。
- Laravel：provider 的 `map()` 可达方法及 group 加载、嵌套前缀和 namespace、常用 HTTP 方法、`any/match`、`resource/apiResource/resources/apiResources`、`only/except/parameters`。
- PHP：namespace/use、工作区 PSR-4 类文件、构造器类型注入并赋值属性、直线 `new`、静态方法调用。分支类型和重赋值注入属性保守标记为未解析。
- PHP 关联覆盖控制器、服务及工具类，每个方法记录直接调用，侧栏可继续逐层展开，遇到循环停止。
- Facade：直接继承 Laravel Facade、单一静态 return 的 `getFacadeAccessor()`，支持实现类 `::class` 或容器键。容器键支持工作区直接继承 Laravel ServiceProvider 的类在 `register()` / `boot()` 的直线语句前缀中调用 `$this->app->singleton()` / `bind()`，目标为类常量、完整类名字符串或仅 `return new Concrete` 的闭包。Facade 自身可访问方法优先。冲突、条件和提前退出后的绑定不选择任意目标；出现动态绑定键时保守停用 Facade 转发推断，自定义 `__callStatic` 不推断转发。
- 不模拟服务提供者实际加载和容器运行时状态。父类继承方法回溯、Trait 方法、Facade 中间父类、复杂工厂及容器别名、跨函数数据流、复杂请求包装、Vue 模板表达式和 Vuex 间接分发不在当前推断范围内。
- 路由匹配按 HTTP 方法和路径段进行，不模拟运行时条件、注册覆盖顺序、域名分流、中间件和正则 `where` 约束。多个静态候选全部列出，不能当作生产真实路由结果。资源参数单数化覆盖常见词形，不含 Laravel 完整词典。
- PHP 7.1 解析模式下，`clone($value)` 等部分合法写法可能触发 `php-parser` 限制。受影响文件会显示解析诊断，文件内方法暂不参与导航；诊断不代表已证明应用代码有语法错误。
- 未确定的调用显示“未解析”，缺失关系不等于代码没有调用。树表示关联，不表示运行时执行先后顺序。

## 开发、验证与打包

插件依赖独立管理，使用 Node.js 20 或更新版本（本次使用 24），不使用项目根目录的旧构建脚本。

```bash
cd vscode-business-navigator
npm ci --ignore-scripts
npm run check
npm run build
npm test
npm run test:host
npm run package
```

`test:host` 默认使用本机 `/Applications/Visual Studio Code.app/Contents/MacOS/Electron`。可通过 `VSCODE_EXECUTABLE` 指定其他可执行文件。它创建临时源码、多根工作区、用户配置和扩展目录并在完成后删除；不会安装到用户的 VS Code 配置。可用 `BUSINESS_NAV_EXTENSIONS_DIR` 指定隔离安装的兼容性测试插件目录。

所有测试夹具随仓库提供，不依赖原业务项目或其目录。自动测试覆盖 AST 关联、动态边界、资源实例、错误隔离、打包 Worker；宿主测试覆盖定义提供者、F12 对应命令、引用、侧栏命令、固定入口、未保存修改、关闭丢弃、嵌套工作区编辑和文件重命名。鼠标 Cmd+点击和侧栏视觉布局还需实际编辑器交互验收，不能由这些断言替代。

开发调试可运行：

```bash
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --extensionDevelopmentPath="$PWD" /path/to/laravel-project
```

## 初版验证记录

类型检查、构建、23 项自动化测试及 VSIX 打包通过。真实 VS Code 宿主中的定义、F12 对应命令、Vue/API 与注入服务导航、反向引用、侧栏命令、固定入口、编辑丢弃、嵌套工作区和重命名验收通过；Intelephense 1.18.5 + Vetur 0.37.3 共存运行的同组验收也通过。物理 Cmd+鼠标点击和侧栏视觉布局未完成独立交互验收，不将命令测试等同于鼠标测试。

源码与功能日志分别位于 `src/` 和 `doc/`；生成的 `node_modules/`、`out/`、`dist/`、VSIX 均不进入 Git，运行构建和打包命令即可生成。

最新 0.1.2 的构建、31 项自动化测试，以及 VS Code / Cursor 隔离宿主中的 Facade 实现跳转、反向引用和绑定修改 / 丢弃验收通过；本地验收平台为 macOS，Windows / Linux 尚未独立验收。

发布维护步骤见 [GitHub 分发](doc/发布/GitHub分发.md)。问题反馈请附插件版本、编辑器版本、相关目录配置及脱敏的最小示例，提交到 [GitHub Issues](https://github.com/lijiaguo042-coder/vscode-business-navigator/issues)。
