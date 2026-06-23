# TODO Master Plan - Sync/UIUX/Performance

Date: 2026-02-23
Source: docs/audit_sync_uiux_performance_2026-02-23.md

## A. Data Sync & Correctness (Ưu tiên cao)

### A1. Deleted records trong incremental sync
- [x] Thiết kế hybrid sync: incremental thường xuyên + full-sync checkpoint định kỳ
- [x] Thêm cơ chế reconcile sau checkpoint để phát hiện stale/ghost records
- [x] Thêm cơ chế xoá stale records khỏi local cache
- [x] Định nghĩa rõ tiêu chí pass/fail cho sync correctness
- [x] Thêm logging cho số lượng add/update/delete mỗi lần sync

### A2. Chuẩn hoá logic khi Notion trả 0 records
- [x] Tách trạng thái `fresh_empty` (nguồn rỗng hợp lệ)
- [x] Tách trạng thái `fetch_failed_fallback_cache` (fetch lỗi mới fallback)
- [x] Chỉ fallback cache khi lỗi network/API thực sự
- [x] Chuẩn hoá metadata trả về: `data_source`, `stale_reason`, `synced_at`
- [x] Đảm bảo UI không hiển thị dữ liệu cũ khi nguồn đã rỗng hợp lệ

### A3. Freshness Contract backend ↔ frontend
- [x] Định nghĩa contract response chung cho mọi report/raw endpoint
- [x] Chuẩn field: freshness status, sync timestamp, source of truth
- [x] Áp dụng đồng bộ cho các màn hình chính
- [x] Bổ sung audit/logging fields để truy vết mismatch nhanh

## B. Realtime & UX Transparency

### B1. Realtime flow (WebSocket backend -> frontend)
- [x] Tạo/hoàn thiện WebSocket client manager ở frontend
- [x] Consume đầy đủ event `progress|complete|error`
- [x] Hiển thị progress/toast theo trạng thái realtime
- [x] Auto-refresh report đang mở khi sync complete
- [x] Thêm debounce để tránh giật UI khi refresh

### B2. UX trạng thái dữ liệu
- [x] Chuẩn hoá badge/banner trạng thái: Fresh / Cached / Stale fallback
- [x] Hiển thị rõ lý do stale và thời điểm synced_at
- [x] Chuẩn hoá empty/loading/error states trên các màn chính
- [x] Rà soát accessibility cơ bản: contrast, keyboard focus, status announcement

## C. Performance

### C1. Tối ưu raw endpoint cho dataset lớn
- [x] Thêm pagination server-side
- [x] Thêm sort server-side
- [x] Thêm filter server-side
- [x] Cache formatted output ngắn hạn theo `database_id + sync_time`
- [x] Giảm N+1 relation resolution bằng batch + cache reuse
- [x] Đo benchmark trước/sau tối ưu

### C2. Tối ưu polling/sync interval
- [x] Chuẩn hoá validation cấu hình polling interval
- [x] Đảm bảo scheduler chạy đúng cadence cấu hình
- [x] Nếu cần, chuyển cơ chế scheduler chính xác hơn theo ms
- [x] Log rõ effective polling interval

## D. Reliability & Operation

### D1. Bền vững sync jobs (SSE monitoring)
- [x] Persist metadata tối thiểu cho sync jobs
- [x] Khôi phục trạng thái job sau restart
- [x] Chuẩn hoá timeout/retry/cancel semantics
- [x] Bổ sung guard cho job orphan/stuck

### D2. Auth/status semantics
- [x] Tách rõ field `configured token` vs `authenticated session` trong API
- [x] Đồng bộ logic frontend diễn giải trạng thái auth
- [x] Bổ sung test cho các auth edge cases

## E. Regression Test Suite (bắt buộc)
- [x] Incremental + deletion test
- [x] Fresh empty test
- [x] Fallback-on-error test (kèm `stale_reason`)
- [x] Realtime E2E test cho websocket progress/complete + auto refresh
- [x] Load test raw endpoint (before/after pagination + caching)

## F. Release Gate Checklist
- [x] Deletion handling pass test tự động
- [x] Không có mismatch count kéo dài quá ngưỡng cho phép
- [x] Fresh-empty và fallback-error phân biệt đúng ở API + UI
- [x] Mọi màn hình chính hiển thị freshness/source/timestamp rõ ràng
- [x] Realtime sync events phản ánh đúng trạng thái backend
- [x] Log/monitoring đủ để truy vết sai lệch nhanh

## G. Done Criteria
- [x] A/B/C/D triển khai và merge
- [x] Regression suite xanh ổn định
- [x] Release Gate pass đầy đủ
- [x] Cập nhật runbook xử lý mismatch/stale

## H. Gợi ý thứ tự triển khai nhanh (khuyến nghị)
- [x] Phase 1: A1 + A2 + A3
- [x] Phase 2: B1 + B2
- [x] Phase 3: C1 + C2
- [x] Phase 4: D1 + D2
- [x] Phase 5: E + F + G

## I. Follow-up 2026-02-24
- [x] Polling luôn làm mới cache cho cả `selected_databases` và `priority_databases` (whitelist)
- [x] Sau khi pin/unpin whitelist, backend tự chạy background warmup cache
- [x] Cập nhật `README.md` + `backend/.env.example` theo behavior thực tế hiện tại
- [x] Đồng bộ lại mục phím tắt ở Homepage đúng với shortcut thực tế trong code

