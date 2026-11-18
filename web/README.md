# web — 前端

本目录是 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT）的改造版，作为
「DeepSleep」自建网页版的前端使用。**完整说明见仓库根目录的 [`README.md`](../README.md)。**

与原版的差异：

- 会话、附件原件的存储从浏览器 IndexedDB 改为自建后端 API（多端共享）
- 新增账号密码登录页、账号设置页（API Key 绑定、改密、退出登录）
- DeepSeek API 请求改由后端反向代理（`/api/ds`），浏览器不再持有 API Key
- 移除请求中的 `safety_check`（模型内容安全）参数
- 每条回答下方显示费用估算

开发命令（一般不需要，构建与运行都在 Docker 内完成，见根 README）：

```bash
pnpm install
pnpm dev    # 8090 端口，/api 代理到 3080 的后端
pnpm build  # 产物在 dist/
pnpm type
pnpm lint
```

原始 README 保留在 [`README.zh-CN.md`](README.zh-CN.md) 中，供对照上游功能说明。
