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

## 供 AI 或脚本写入

服务提供 `POST /api/ai/links`，用于一次写入 1–100 条书签。它接受文件夹名称（不存在时会自动创建）、会为没有协议的网址补上 `https://`，并默认跳过已存在的同 URL 书签。调用仍只允许本机地址且必须携带同一个配对令牌。

```sh
TOKEN="$(cat data/api-token)"
curl http://127.0.0.1:3721/api/ai/links \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "links": [
      {"url":"github.com/openai", "title":"OpenAI GitHub", "folderName":"开发"},
      {"url":"https://example.com/article", "description":"一篇待读文章", "folderName":"稍后阅读"}
    ],
    "onDuplicate":"skip"
  }'
```

`onDuplicate` 可为 `skip`（默认，返回在 `skipped`）、`update`（更新标题、描述、显示名、外观并移动到指定文件夹）或 `create`（保留重复条目）。也可传 `folderId` 使用既有文件夹；单条数据不能同时传 `folderId` 和 `folderName`。未指定时写入 `收集箱`，并可用 `defaultFolderName` 改名；`createMissingFolders: false` 会在目标文件夹不存在时拒绝请求。响应包含 `created`、`updated`、`skipped` 和 `foldersCreated`，方便调用方确认实际结果。

## 书签导入与导出

导出采用稳定的 JSON 结构 `local-speed-dial/bookmarks`（当前 `version: 1`）。它只包含书签库数据：文件夹、链接、外观覆盖和全局展示设置；不会导出 API 令牌、Chrome 浏览历史、点击记录、抓取缓存或本机绝对路径。

| 范围 | 导出 | 导入 |
| --- | --- | --- |
| 全部书签库 | `GET /api/export` | `POST /api/import`，传入 `scope: "library"` 的导出文件 |
| 单个文件夹 | `GET /api/folders/:id/export` | `POST /api/import`，传入 `scope: "folder"` 的导出文件；可选 `targetFolderId` 导入到指定已有文件夹 |

全库导出的主体如下（`folders` 按顺序保存，每个文件夹的 `links` 也按顺序保存）：

```json
{
  "format": "local-speed-dial/bookmarks",
  "version": 1,
  "scope": "library",
  "exportedAt": "2026-08-11T10:00:00.000Z",
  "settings": { "theme": "system", "layout": "grid" },
  "folders": [{
    "name": "开发",
    "autoRules": ["github.com"],
    "links": [{
      "url": "https://github.com/openai",
      "title": "OpenAI GitHub",
      "description": null,
      "displayName": null,
      "appearanceOverride": null
    }]
  }]
}
```

导入请求包装该导出结构，并默认采用非破坏性的 `skip`：

```sh
curl http://127.0.0.1:3721/api/import \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"bundle": {"format":"local-speed-dial/bookmarks","version":1,"scope":"folder","exportedAt":"2026-08-11T10:00:00.000Z","folders":[{"name":"开发","autoRules":[],"links":[{"url":"github.com/openai"}]}]}, "onDuplicate":"skip"}'
```

`onDuplicate` 同样支持 `skip`、`update`、`create`。默认会创建缺失文件夹，可用 `createMissingFolders: false` 改为严格校验。全库导入默认更新全局展示设置，传 `includeSettings: false` 可只导入书签；单文件夹导入可用 `targetFolderId` 改变落点。导入不会删除已有书签或文件夹。

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
