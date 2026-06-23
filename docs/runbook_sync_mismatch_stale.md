# Runbook - Xử Lý Mismatch / Stale Data

Date: 2026-02-24
Scope: Dash Notion sync correctness, freshness, realtime, raw endpoint.

## 1) Triệu chứng thường gặp

- UI hiển thị dữ liệu cũ dù đã sync.
- Raw API trả dữ liệu fallback (`fetch_failed_fallback_cache`).
- Count Local vs Notion lệch kéo dài.
- Sync job bị treo/timeout/cancelled.

## 2) API chẩn đoán nhanh

1. `GET /api/status`
   Mục tiêu: kiểm tra `effective_polling_interval_ms`, trạng thái token/session.

2. `GET /api/sync/correctness` (Admin)
   Mục tiêu: kiểm tra pass/fail release gate kỹ thuật:
   - `stale_checkpoint_databases`
   - `mismatch_over_threshold_databases`
   - `suspicious_growth_databases`

3. `GET /api/sync/overview` + `POST /api/sync/check`
   Mục tiêu: xác minh mismatch chi tiết theo từng database.

4. `GET /api/database/:id/raw?refresh=true`
   Mục tiêu: ép fetch Notion để xác nhận trạng thái thực:
   - `fresh`
   - `fresh_empty`
   - `fetch_failed_fallback_cache` (kèm `stale_reason`)

## 3) Quy trình xử lý theo mức độ

### A. Mismatch nhẹ (không kéo dài)

1. Chạy `POST /api/sync/check` cho DB bị lệch.
2. Chạy `POST /api/sync/single` cho DB đó.
3. Xác nhận lại bằng `/api/database/:id/raw?refresh=true`.

### B. Mismatch kéo dài / stale lặp lại

1. Chạy `POST /api/sync/start` (resume=false) để sync toàn bộ.
2. Theo dõi SSE `GET /api/sync/stream/:jobId`.
3. Nếu job timeout/cancelled: xem `sync_jobs.json` và retry.
4. Chạy lại `GET /api/sync/correctness` đến khi `pass=true`.

### C. Fallback cache do lỗi fetch

1. Đọc `stale_reason` từ response raw.
2. Kiểm tra token/quyền Notion, network, rate limit.
3. Sau khi fix hạ tầng, gọi lại `refresh=true` để xác nhận về `fresh`/`fresh_empty`.

## 4) Dấu hiệu đạt Release Gate

- `GET /api/sync/correctness` trả `pass=true`.
- Không còn DB trong:
  - `stale_checkpoint_databases`
  - `mismatch_over_threshold_databases`
- Các màn chính hiển thị freshness/source/timestamp rõ ràng.
- Realtime progress/complete hoạt động ổn định.

## 5) Lệnh test/regression đề xuất

1. `npm --prefix backend test`
2. Kiểm tra artifact benchmark:
   `backend/tests/artifacts/raw_load_benchmark.json`
3. Test syntax nhanh:
   - `node --check backend/src/api/routes.js`
   - `node --check backend/src/notion/fetcher.js`
   - `node --check frontend/public/js/app.js`

