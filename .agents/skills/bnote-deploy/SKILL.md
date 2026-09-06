---
name: bnote-deploy
description: 构建 bnote（Tauri 应用）并替换正在运行/已安装的 /Applications/bnote.app。当用户要求"构建并替换"、"打包部署"、"更新一下应用"、"构建启动"、"发布一版试试"等，涉及 bnote 的构建、打包、部署、替换运行实例时使用；也支持只构建不部署。涉及前端改动是否要构建由用户决定时不要擅自运行（曾明确过"只调试不构建"）。
---

# bnote 构建与部署

把当前代码构建成 release 包并替换系统里正在运行的 bnote。完整流程已封装在脚本里，
直接运行即可，不要手工重打一遍命令。

## 使用

```bash
# 完整流程：类型检查 → 构建 → 退出运行实例 → 替换 /Applications/bnote.app → 启动验证
.agents/skills/bnote-deploy/scripts/deploy.sh

# 变体
.agents/skills/bnote-deploy/scripts/deploy.sh --skip-typecheck  # 跳过 tsc（纯样式/文档改动）
.agents/skills/bnote-deploy/scripts/deploy.sh --build-only      # 只构建不部署（产出 app + dmg）
.agents/skills/bnote-deploy/scripts/deploy.sh --dry-run         # 只打印将执行的步骤
```

脚本做什么：

1. `pnpm exec tsc --noEmit`（除非 `--skip-typecheck`）
2. `pnpm tauri build`（完整日志在 /tmp/bnote-build.log，失败时输出尾部）
3. 优雅退出运行中的实例：先 AppleScript 按 bundle id 退出，再 pkill 清理二进制已被删除的僵尸实例
4. `rm -rf /Applications/bnote.app && ditto <新包> /Applications/bnote.app`
   （必须先删再 ditto；ditto 保留元数据与签名，不要用 cp -R）
5. `open` 启动并用 pgrep 验证进程存在，报告新 DMG 路径

## 注意

- 构建通常 1–3 分钟（cargo 增量）；用 `run_in_background` 跑脚本避免超时。
- 部署会退出用户正在使用的 bnote 实例（含自动保存，最多丢最后一秒输入），
  这是流程的一部分，不需要额外确认。
- 不要动 `/Volumes/bnote` 下挂载的 DMG 里的旧版（只读镜像，无法更新）。
- 替换后若 Dock 图标没变，是系统图标缓存，`killall Dock` 或注销刷新。
- 用户明确说"不用构建/只调试"时，禁止运行本 skill；在 dev server 里验证即可。
