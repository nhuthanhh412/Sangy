# Dash Notion

Dashboard phân tích dữ liệu Notion theo thời gian thực, tối ưu cho whitelist project, có cache cục bộ dạng file và sync nền định kỳ.

## Tính năng hiện có

- Đọc dữ liệu Notion bằng `NOTION_ACCESS_TOKEN` / `NOTION_TOKEN` (không bắt buộc OAuth flow trên UI).
- Sidebar project tree + whitelist pin/unpin.
- Polling nền với incremental sync + full-sync checkpoint định kỳ để loại stale/ghost records.
- Realtime progress qua WebSocket, frontend tự refresh report khi sync hoàn tất.
- Bộ report: Sprint, Productivity, Raw Data, Raw All Projects (whitelist), Burndown, Sync Monitor (Admin).
- Chatbot preview widget qua API `GET /api/chat/config` + `POST /api/chat`.
- Cache cục bộ split-file:
  - `backend/data/cache/*.json`: dữ liệu theo từng database
  - `backend/data/config.json`: cấu hình chạy
  - `backend/data/metadata.json`: sync times, audit, relation cache

## Yêu cầu

- Node.js `>=18`
- Notion Integration Token đã có quyền đọc các database cần dùng

## Chạy nhanh

```bash
# Cài dependencies backend
cd backend
npm install

# Tạo file env
copy .env.example .env

# Chạy server
npm start
```

Hoặc từ root:

```bash
npm start
```

Mặc định app chạy ở `http://localhost:3000`.

## Cấu hình môi trường

`backend/.env`:

```env
# Bắt buộc: token Notion (ưu tiên NOTION_ACCESS_TOKEN)
NOTION_ACCESS_TOKEN=secret_xxx
# NOTION_TOKEN=secret_xxx

# Server
PORT=3000
CORS_ORIGIN=http://localhost:3000
SESSION_SECRET=replace_with_strong_secret

# Polling / Sync
POLLING_INTERVAL=300000
FULL_SYNC_CHECKPOINT_MS=21600000
RAW_FORMAT_CACHE_TTL_MS=120000
RAW_RELATION_RESOLVE_MAX_ROWS=400

# Admin / Sync monitor
ADMIN_MODE=false
SYNC_JOB_TIMEOUT_MS=1800000
SYNC_JOB_RETRY_LIMIT=1
SYNC_MISMATCH_THRESHOLD=0
SYNC_MISMATCH_CONSECUTIVE_LIMIT=2

# Chatbot preview (optional)
CHATBOT_ENABLED=true
AI_API_KEY=
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini

# Data directory (optional)
# DATA_DIR=./data
```

## Whitelist và cache

- File whitelist: `backend/data/priority_projects.json`.
- Poller luôn sync cả `selected_databases` và `priority_databases` (whitelist) để giữ cache nóng.
- Khi pin/unpin whitelist, backend sẽ:
  - cập nhật file whitelist,
  - clear formatted raw cache,
  - kích hoạt background warmup để làm mới cache sớm.

## Scripts hữu ích

```bash
# Chạy test backend
npm --prefix backend test

# Chạy backend ở mode watch
npm --prefix backend run dev
```

## Tài liệu nội bộ

- `docs/todo_master_plan_2026-02-23.md`
- `docs/audit_sync_uiux_performance_2026-02-23.md`
- `docs/runbook_sync_mismatch_stale.md`
