# Local Speed Dial API 使用说明

本机 API 适合脚本、自动化工具和 AI Agent 读写书签。默认地址是 `http://127.0.0.1:3721`。

## 认证

除 `GET /health` 外，请求都需要 Bearer Token。首次启动生成的 Token 位于 `data/api-token`。

```bash
TOKEN="$(tr -d '\r\n' < data/api-token)"
curl http://127.0.0.1:3721/health
curl http://127.0.0.1:3721/api/folders \
  -H "Authorization: Bearer $TOKEN"
```

API 只应绑定到回环地址。不要把端口转发到公网，也不要把 Token 写进公开代码或日志。

## 批量添加链接

`POST /api/ai/links` 一次接受 1–100 条链接。每条记录可以使用 `folderId`，也可以直接使用更适合自动化调用的 `folderName`。

```bash
curl -X POST http://127.0.0.1:3721/api/ai/links \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "onDuplicate": "skip",
    "links": [
      {
        "url": "github.com",
        "title": "GitHub",
        "description": "代码托管与协作",
        "folderName": "开发工具"
      },
      {
        "url": "https://developer.mozilla.org/",
        "folderName": "参考资料"
      }
    ]
  }'
```

未带协议的域名会自动补为 HTTPS。若 `folderName` 不存在，服务会创建文件夹。

### 重复策略

| `onDuplicate` | 行为 |
| --- | --- |
| `skip` | 跳过已存在的规范化 URL，推荐作为默认策略 |
| `update` | 更新已存在的链接 |
| `create` | 明确创建重复项 |

响应会把结果分桶，调用方无需解析提示文本：

```json
{
  "created": [],
  "updated": [],
  "skipped": [],
  "foldersCreated": []
}
```

网页标题、描述或图标抓取是尽力而为的补充步骤。目标网站返回 403、429 或超时，不代表书签写入失败。

## 导入与导出

便携格式标识为 `local-speed-dial/bookmarks`，当前版本为 `1`。

### 导出全部数据

```bash
curl http://127.0.0.1:3721/api/export \
  -H "Authorization: Bearer $TOKEN" \
  -o bookmarks.json
```

### 导出单个文件夹

```bash
FOLDER_ID="替换为文件夹ID"

curl "http://127.0.0.1:3721/api/folders/$FOLDER_ID/export" \
  -H "Authorization: Bearer $TOKEN" \
  -o folder-bookmarks.json
```

### 导入

导入接口需要把导出内容放入 `bundle` 字段。下面的示例使用 `jq` 生成请求文件：

```bash
jq -n --slurpfile bundle bookmarks.json \
  '{bundle: $bundle[0], onDuplicate: "skip"}' > import-request.json

curl -X POST http://127.0.0.1:3721/api/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @import-request.json
```

把单文件夹内容导入指定文件夹时，可以在请求中增加 `targetFolderId`：

```json
{
  "bundle": {},
  "targetFolderId": "目标文件夹ID",
  "onDuplicate": "skip"
}
```

其中 `bundle` 应替换为完整的导出 JSON 对象。

导出包含有序文件夹、自动规则、链接、卡片外观，以及按请求选择的设置。它不会包含 Token、浏览历史、点击事件、网页元信息缓存或本机绝对路径。

## 常用接口

| 方法与路径 | 用途 |
| --- | --- |
| `GET /health` | 无认证健康检查 |
| `GET /api/folders` | 获取有序文件夹列表 |
| `GET /api/folders/:folderId/links` | 获取一个文件夹中的链接 |
| `GET /api/settings` | 获取页面设置 |
| `POST /api/ai/links` | 批量写入链接 |
| `GET /api/links/duplicates?url=...` | 查询规范化 URL 的重复项 |
| `GET /api/recommendations` | 获取常用和最近链接 |
| `GET /api/history` | 搜索和分页读取本机历史库 |
| `GET /api/export` | 导出全库 |
| `GET /api/folders/:id/export` | 导出单个文件夹 |
| `POST /api/import` | 导入便携 JSON |

前后端共享的详细字段约束以 `packages/contracts/src/index.ts` 为准。为避免破坏数据，不建议绕过 API 直接写 SQLite。

## 历史记录分页

`GET /api/history` 支持：

- `query`：搜索文本；
- `limit`：每页条数；
- `cursorTime`：上一页末尾的访问时间；
- `cursorUrl`：上一页末尾的 URL。

排序固定为最近访问时间降序，再按 URL 升序。继续分页时应同时回传响应给出的时间和 URL 游标，以免同一时间戳下漏项或重复。

## 自动化调用建议

- 默认使用 `onDuplicate: "skip"`，只有明确意图时才更新或制造重复项；
- 批次不要超过 100 条；
- 优先传 `folderName`，让服务处理文件夹查找和创建；
- 根据 `created`、`updated`、`skipped`、`foldersCreated` 判断结果；
- 将网页信息补全失败视为非致命结果；
- 先导出备份，再执行大批量更新或导入。
