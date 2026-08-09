# Local Speed Dial

一个本地优先的 Chrome 新标签页书签库。它不读取或回写 Chrome 原生书签；标签、链接、展示设置和点击事件都由本机 SQLite 后端保存。

## 本地运行

```sh
pnpm install
pnpm dev:server
pnpm --filter @local-speed-dial/extension build
```

服务默认监听 `http://127.0.0.1:3721`，首次启动会在 `data/api-token` 生成一个仅限本机 API 使用的配对令牌。将 `apps/extension/dist` 作为“已解压的扩展程序”加载到 `chrome://extensions`，打开新的标签页，点击右上角设置，将该令牌粘贴到“配对令牌”中。

Chrome 扩展能够稳定覆盖的是**新标签页**。如果希望它成为日常入口，可在 Chrome 的启动设置中选择“打开新标签页”；主页按钮仍由浏览器的主页设置管理。

## 开发和验证

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

本地数据默认为 `data/speed-dial.sqlite`。备份时先停止服务，再复制整个 `data/` 目录；其中包含数据库及配对令牌，请勿提交或共享。

## 安全边界

- API 只绑定 `127.0.0.1`，除健康检查外都需要 bearer token。
- 元数据抓取只接受 HTTP(S)，限制重定向、响应大小和超时，并阻止 loopback、私网和 link-local 地址，防止 SSRF。
- 未配置或暂时连不上本机服务时，扩展展示连接错误；已展示的链接仍可直接打开。
