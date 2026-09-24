---
title: PiDeck 临时版构建与正式版隔离
type: tip
created: 2026-09-22T12:01:13.677Z
keywords:
  - PiDeck
  - 临时版
  - 正式版
  - 构建
  - userData
  - 单实例
  - release-dev
  - 对应工作区
  - managed-worktrees
sourceRef: scripts/dist-win-dev.js; scripts/pack-dev.js; src/main/index.ts; src/main/git/WorktreeService.ts
lifecycleStatus: active
---

# PiDeck 临时版构建与正式版隔离

构建临时验证版时，必须让临时版与正式版在构建产物、应用身份、数据目录、单实例锁、通知身份和协议注册上全部隔离。

当前约定：

- 使用 `npm run dist:win:dev` 或 `npm run pack:dev`，不要手动复用 `release/` 下的正式版 EXE。
- 临时构建注入 `PIDECK_DEV_BUILD=1`，运行时使用 `PiDeck-Dev` 身份、独立 AppUserModelId 和 `%APPDATA%/pi-desktop-dev` 数据目录。
- 临时构建输出固定为当前源码工作区根目录下的 `release-dev/`；必须从要验证的对应 Git worktree 根目录执行构建，不要在主项目或项目同级目录构建后再把产物复制到另一个工作区。
- 当前 PiDeck Git worktree 的生产目录位于 `%APPDATA%/pi-desktop-dev/managed-worktrees/<repo-key>/<branch>/`，不同项目即使分支同名也各自隔离；临时版的 `release-dev/` 应属于正在构建的那个工作区，不写入项目同级目录，也不放进其他项目的 worktree。
- 构建脚本开始前必须删除当前工作区旧的 `release-dev/`，避免误启动旧 EXE。
- 临时安装包/便携包文件名必须带 `temporary`，打开或分发时只使用本次构建生成的该文件，不要点击旧的 `PiDeck-Dev` 或 `win-unpacked/PiDeck-Dev.exe`。
- 临时版不注册正式版的 `pideck://` 协议，避免通知或协议唤起正式版。
- 正式版使用 `release/` 和正式 `pi-desktop` 数据目录；临时版不得写入正式数据目录或复用正式单实例锁。

排查“临时版 EXE 打开正式版页面”时，先关闭所有 PiDeck 进程，删除/重建 `release-dev/`，再从本次构建输出的带 `temporary` 文件名启动，并检查窗口标题是否为 `PiDeck-Dev · 临时版`、数据目录是否为 `pi-desktop-dev`。
