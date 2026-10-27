# API 跳转目标切换

## 设计

API URL 的 Cmd+点击 / F12 默认先打开 Laravel 路由；继续在路由的控制器处理器上跳转，可进入控制器方法。

新增 VS Code 设置 `businessNavigator.apiDefinitionTarget`，枚举为 `route`（默认）和 `controller`。设置支持在工作区覆盖，通过 VS Code 设置界面或 settings.json 修改，不增加专用切换命令。每次定义查询读取当前设置，切换无需重启。

复用 `NavigationIndex.definitions` 的关系图查询，仅在目标为路由时选择返回路由节点或其控制器。没有可解析控制器的路由，在 route 模式下仍可打开。多个候选继续交给原生候选列表。查找引用固定按控制器目标解析，侧栏和其他定义跳转保持现有行为。

## 实施步骤

- [x] 在 `test/index.test.cjs` 增加默认路由、控制器模式及缺失控制器用例，先运行确认默认路由用例失败。
- [x] 在 `src/index.ts` 扩展现有定义查询参数，在 `src/extension.ts` 中读取设置，并明确引用查询的目标模式。
- [x] 在 `package.json` 注册枚举设置，更新 README，版本升为 0.1.1，同步锁文件版本。
- [x] 更新真实 VS Code 宿主测试，验证默认路由、路由到控制器、配置切换和反向引用。
- [x] 使用 Node 24 构建，执行自动化测试、宿主测试和真实业务项目只读索引检查。

交付版本为 0.1.1，使用 `npm run package` 生成对应 VSIX。

## 配置示例

```json
{
  "businessNavigator.apiDefinitionTarget": "route"
}
```

将 `route` 改为 `controller` 即可恢复 URL 直接跳控制器。

## 验证记录

- 构建（包含 TypeScript 类型检查）通过，25 项自动化测试全部通过。
- 真实 VS Code 隔离宿主测试通过，退出码为 0；覆盖默认路由、动态切换控制器模式、恢复默认、连续两次 F12 命令、URL 引用及既有编辑失效场景。
- 使用 `operator-admin-platform` 当前源码只读构建索引，`getBlacklist` 默认定位 `routes/admin-api.php`，控制器模式及路由处理器均定位 `UserDataQueryController::getBlacklist`；没有修改业务项目。
- 宿主首次在沙箱内启动以 SIGABRT 退出；沙箱外隔离运行通过。宿主联网握手失败等 VS Code 日志未阻止上述断言完成。
- 物理鼠标 Cmd+点击未独立人工验收，以上程序化 F12 和定义提供者检查不替代鼠标交互验收。
