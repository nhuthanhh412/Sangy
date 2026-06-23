# Audit Report → Master Implementation Plan (UI/UX, Performance, Data Sync & Correctness)

Date: 2026-02-23  
Scope: `backend/src`, `frontend/public/js`  
Method: static code review + lightweight runtime sanity checks

## 1) Mục tiêu tổng

Plan này chuyển toàn bộ findings thành **kế hoạch triển khai thống nhất**, tập trung vào:
- Đảm bảo dữ liệu luôn **mới nhất và đúng nhất** (freshness + correctness).
- Giảm rủi ro stale/ghost data, đặc biệt khi incremental sync.
- Nâng chất lượng UX (trạng thái sync rõ ràng), cải thiện performance và reliability.

---

## 2) Master Plan (không chia theo ngày)

## A. Data Sync & Correctness Plan (Ưu tiên cao nhất)

### A1. Xử lý triệt để bài toán deleted records trong incremental sync
**Vấn đề:** `upsert` chỉ add/update, không prune record đã bị xoá ở Notion.  
**Việc cần làm:**
1. Thiết kế chiến lược đồng bộ lai:
   - Incremental sync cho vòng thường.
   - Full-sync checkpoint định kỳ để reconcile và xoá record stale.
2. Thêm cơ chế phát hiện/xoá stale records sau checkpoint.
3. Định nghĩa rõ tiêu chí pass/fail cho “sync correctness”.

**Kết quả kỳ vọng:** local cache không giữ ghost records lâu dài; số liệu report nhất quán với nguồn.

### A2. Chuẩn hóa logic khi Notion trả 0 records
**Vấn đề:** endpoint raw hiện có khả năng fallback cache cũ khi fetch mới trả rỗng, dễ che giấu empty-state hợp lệ.  
**Việc cần làm:**
1. Tách rõ 2 trạng thái:
   - `fresh_empty` (nguồn thật sự rỗng, hợp lệ).
   - `fetch_failed_fallback_cache` (lỗi fetch nên dùng cache tạm).
2. Chỉ fallback cache khi lỗi thật sự (network/API).
3. Trả metadata chuẩn: `data_source`, `stale_reason`, `synced_at`.

**Kết quả kỳ vọng:** không còn hiển thị dữ liệu cũ khi nguồn đã rỗng hợp lệ.

### A3. Chuẩn hóa “Freshness Contract” giữa backend và frontend
**Việc cần làm:**
1. Định nghĩa contract response chung cho mọi report/raw endpoint:
   - freshness status
   - sync timestamp
   - source of truth
2. Áp dụng đồng bộ cho các màn hình chính.
3. Bổ sung logging/audit fields để truy vết mismatch nhanh.

**Kết quả kỳ vọng:** user luôn biết dữ liệu đang xem là fresh/cached/stale.

---

## B. Realtime & UX Transparency Plan

### B1. Hoàn thiện luồng realtime (backend WebSocket → frontend)
**Vấn đề:** backend đã broadcast tiến độ sync nhưng frontend chưa consume đầy đủ.  
**Việc cần làm:**
1. Thêm WebSocket client manager ở frontend.
2. Render progress/toast theo event `progress|complete|error`.
3. Auto refresh report đang mở khi sync complete (có debounce tránh giật UI).

**Kết quả kỳ vọng:** giảm thao tác refresh thủ công, trạng thái sync trực quan.

### B2. Chuẩn UX cho trạng thái dữ liệu
**Việc cần làm:**
1. Chuẩn hóa badge/banner trạng thái:
   - Fresh from Notion
   - Cached X phút
   - Stale fallback (kèm lý do)
2. Bổ sung empty/loading/error states nhất quán.
3. Rà soát accessibility cơ bản (contrast, keyboard focus, thông báo trạng thái).

**Kết quả kỳ vọng:** tăng độ tin cậy dữ liệu trong mắt người dùng, giảm hiểu nhầm.

---

## C. Performance Plan

### C1. Tối ưu raw endpoint cho dataset lớn
**Vấn đề:** format full dataset + resolve ID có thể nặng.  
**Việc cần làm:**
1. Thêm pagination/sort/filter server-side cho raw API.
2. Cache formatted output ngắn hạn theo `database_id + sync_time`.
3. Giảm N+1 trong relation resolution (batch + cache reuse).

**Kết quả kỳ vọng:** giảm latency, giảm memory spike, trải nghiệm mượt hơn.

### C2. Tối ưu tần suất sync/polling
**Vấn đề:** cron granularity có thể lệch với interval cấu hình.  
**Việc cần làm:**
1. Chuẩn hóa rule cấu hình polling interval (validation rõ ràng).
2. Nếu cần, thay scheduler bằng cơ chế chính xác hơn theo ms.
3. Log rõ “effective polling interval” để tránh hiểu sai.

**Kết quả kỳ vọng:** dữ liệu cập nhật đúng cadence mong muốn.

---

## D. Reliability & Operation Plan

### D1. Làm bền vững sync jobs (SSE monitoring)
**Vấn đề:** job state đang in-memory, restart là mất.  
**Việc cần làm:**
1. Persist metadata tối thiểu cho sync jobs.
2. Có cơ chế recovery trạng thái sau restart.
3. Thêm timeout/retry/cancel semantics rõ ràng.

**Kết quả kỳ vọng:** Sync Monitor ổn định hơn trong môi trường thật.

### D2. Chuẩn hóa auth/status semantics
**Vấn đề:** status dễ lệch giữa “configured token” và “authenticated session”.  
**Việc cần làm:**
1. Tách bạch fields trạng thái trong API.
2. Đồng bộ cách frontend diễn giải trạng thái.
3. Bổ sung test cho các trạng thái auth edge cases.

**Kết quả kỳ vọng:** trạng thái đăng nhập/cấu hình chính xác, tránh hiểu sai.

---

## 3) Test Plan bắt buộc (regression suite)

1. **Incremental + deletion test**: xác nhận local không giữ record đã bị xoá.
2. **Fresh empty test**: Notion trả rỗng hợp lệ thì UI hiển thị empty-state đúng, không fallback sai.
3. **Fallback-on-error test**: khi fetch lỗi mới dùng cache và phải có `stale_reason`.
4. **Realtime E2E test**: nhận websocket progress/complete và tự làm mới report hợp lệ.
5. **Load test raw endpoint**: benchmark trước/sau pagination + caching.

---

## 4) Release Gate (Data Freshness & Correctness)

Chỉ release khi pass toàn bộ:
- [ ] Deletion handling pass test tự động.
- [ ] Không có mismatch count kéo dài quá ngưỡng cho phép.
- [ ] Fresh-empty và fallback-error được phân biệt đúng ở API + UI.
- [ ] Mọi màn hình chính hiển thị rõ freshness/source/timestamp.
- [ ] Realtime sync events phản ánh đúng trạng thái backend.
- [ ] Log/monitoring đủ để truy vết sai lệch dữ liệu nhanh.

---

## 5) Định nghĩa Done cho toàn plan

Plan được xem là hoàn tất khi:
1. Các hạng mục A/B/C/D đã triển khai và merge.
2. Regression suite xanh ổn định.
3. Release Gate pass đầy đủ.
4. Tài liệu vận hành (runbook xử lý mismatch/stale) được cập nhật.

