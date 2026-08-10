# Local Speed Dial

一个本地优先的 Chrome 新标签页书签库。它不读取或回写 Chrome 原生书签；标签、链接、展示设置和点击事件都由本机 SQLite 后端保存。

扩展的“浏览记录”读取本机 SQLite 归档，默认按最后访问时间倒序、按日期分组，支持按标题或网址搜索和加载更早记录。点击即可打开，或将某条记录预填到当前标签的“添加链接”中。

浏览记录同步启用后，扩展会先分批同步现有 Chrome 历史，随后通过后台监听持续写入本机 SQLite。若本机服务暂时未启动，新增记录与 Chrome 的清理通知会先留在扩展本地队列，待服务恢复后重试；清理 Chrome 历史只会在本机库中标记为“已从 Chrome 移除”，不会删除本机归档。

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
- 元数据抓取只接受 HTTP(S)，限制重定向、响应大小和超时，并阻止 loopback、私网和 link-local 地址，防止 SSRF；启动时自动采用系统的 HTTP(S) 代理设置。
- 未配置或暂时连不上本机服务时，扩展展示连接错误；已展示的链接仍可直接打开。
