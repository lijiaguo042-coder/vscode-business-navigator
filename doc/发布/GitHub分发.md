# GitHub 分发

## 分发方式

源码推送到 `lijiaguo042-coder/vscode-business-navigator`，可安装 VSIX 放在 GitHub Release 附件中，版本标签使用 `v` 加 `package.json` 的版本号。依赖、构建产物和 VSIX 不纳入 Git。

公开仓库可让其他人直接下载；私有仓库的 Release 仅对拥有仓库访问权限的人可见。仓库可见性由维护者决定，发布安装包不等同于发布到编辑器扩展商店。

0.1.2 包含相对 API URL 修复、默认路由 / 可选控制器跳转、服务与工具类调用导航，以及明确 Facade 绑定到真实实现的跳转。

## 发布前验证

使用 Node.js 20 以上版本：

```bash
npm ci --ignore-scripts
npm run build
npm test
npm run test:host
npm run package
```

Cursor 隔离宿主在 macOS 上使用：

```bash
VSCODE_EXECUTABLE='/Applications/Cursor.app/Contents/MacOS/Cursor' npm run test:host
```

确认版本清单与锁文件一致；先提交源码，记录提交 SHA；Release 标签指向该提交，附件使用这一份源码构建的 VSIX。不要将业务项目源码、环境文件或访问凭据打入安装包。

## 首次发布 0.1.2

先创建草稿，将 `RELEASE_NOTES.md` 替换为已经准备好的发布说明文件路径，并将 `COMMIT_SHA` 替换为实际源码提交：

```bash
gh release create v0.1.2 ./vscode-business-navigator-0.1.2.vsix \
  --repo lijiaguo042-coder/vscode-business-navigator \
  --target COMMIT_SHA \
  --title 'v0.1.2 · Laravel / Vue 业务链导航' \
  --notes-file RELEASE_NOTES.md \
  --draft
```

检查草稿中的版本、提交、安装说明和附件后再公开发布：

```bash
gh release edit v0.1.2 --repo lijiaguo042-coder/vscode-business-navigator --draft=false --latest
```

后续版本同步调整版本号和标签；不要覆盖已经发布的版本附件，行为变更使用新版本发布。

## 使用者安装

到仓库 Releases 下载 `.vsix`，在 VS Code / Cursor 命令面板执行 `Extensions: Install from VSIX…`，选择文件后重新加载窗口。无需下载源码或安装 Node / PHP。

首次使用打开业务项目根目录，核对 `requestModules`、`requestBasePath` 和 `routeEntrypoints` 等配置是否符合项目实际结构。完整配置、支持范围和限制见根目录 README。
