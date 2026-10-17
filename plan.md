# Group Navigation — plan.md

Version: 2.0  
Ngày chuyển sang Codex: 2026-10-17  
Phạm vi đầu tiên: private beta 3–5 xe

## 1. Mục tiêu

Theo dõi vị trí realtime của một nhóm xe trong chuyến đi. Trưởng nhóm tạo chuyến, chia sẻ mã tham gia và xem các thành viên trên bản đồ.

## 2. Quyết định nền tảng

- Frontend: React, Vite, TypeScript, PWA.
- Backend: Cloudflare Workers.
- Realtime: Durable Objects và WebSocket.
- Database: Cloudflare D1.
- Bản đồ: Google Maps JavaScript API.
- Định vị: Browser Geolocation API.
- Giữ màn hình sáng: Screen Wake Lock API khi trình duyệt hỗ trợ.

PWA là lựa chọn thử nghiệm. GPS nền khi khóa màn hình hoặc chuyển app không được đảm bảo trên iOS và Android.

## 3. Điều kiện bắt buộc trước khi chạy

Ứng dụng chỉ cho bắt đầu hành trình khi:

1. Được mở từ PWA standalone hoặc iOS `navigator.standalone`.
2. Đã cấp quyền GPS.
3. Đã nhận được tọa độ hợp lệ.
4. Đã yêu cầu Wake Lock, hoặc người dùng xác nhận giới hạn thiết bị.
5. Kết nối máy chủ đã sẵn sàng.

Web app không thể tự thay đổi cài đặt tự động khóa màn hình.

## 4. Phase 0 — Technical Proof of Concept

Mục tiêu là kiểm chứng luồng kỹ thuật trên thiết bị thật, chưa deploy production:

- Mở PWA và hiển thị checklist điều kiện thiết bị.
- Theo dõi GPS foreground bằng `watchPosition`.
- Tính tốc độ từ `position.coords.speed` khi có dữ liệu.
- Cho người dùng đặt ngưỡng tốc độ thủ công.
- Hiển thị cảnh báo khi vượt ngưỡng.
- Yêu cầu Screen Wake Lock.
- Kết nối WebSocket tới Durable Object.
- Có schema D1 cho trip, member và location event.
- Hiển thị bản đồ Google khi có key; fallback rõ ràng khi chưa cấu hình.

Không gồm: đăng nhập, định tuyến turn-by-turn, GPS nền đáng tin cậy, âm thanh nền, billing, production auth và dữ liệu thật.

## 5. Driving Assistant

### Phase 0 / Private Beta v1

- Tốc độ hiện tại từ GPS.
- Ngưỡng cảnh báo do người dùng đặt.
- Cảnh báo hình ảnh trong giao diện.
- Hiển thị độ chính xác và thời điểm cập nhật GPS.

Tốc độ GPS có thể sai trong hầm, đô thị hoặc khi tín hiệu yếu. Cảnh báo không thay thế biển báo thực tế.

### Phase sau

- Giới hạn tốc độ theo đoạn đường.
- Biển báo giao thông.
- Dữ liệu OpenStreetMap hoặc nguồn được cấp phép.
- Cảnh báo âm thanh khi app được phép phát.
- Kiểm chứng dữ liệu và xử lý báo sai.

Google Maps hiển thị dữ liệu trong app riêng không đồng nghĩa API bên thứ ba cung cấp đầy đủ dữ liệu đó. Không dùng Google Roads Speed Limits trong Phase 0 để tránh chi phí và vấn đề độ phủ.

## 6. Luồng ứng dụng

1. Trưởng nhóm tạo trip.
2. Hệ thống trả mã trip.
3. Các xe tham gia bằng mã.
4. Mỗi xe cấp quyền GPS.
5. Client gửi vị trí qua WebSocket.
6. Durable Object phát vị trí cho các client cùng trip.
7. D1 lưu metadata và event cần thiết.
8. Trưởng nhóm theo dõi trạng thái online và thời điểm cập nhật.

## 7. API PoC

- `GET /api/health`: kiểm tra Worker.
- `POST /api/trips`: tạo trip thử nghiệm.
- `GET /api/trips/:tripId`: đọc metadata trip.
- `GET /ws/:tripId`: nâng cấp WebSocket vào Durable Object.

PoC chưa có auth. Không dùng endpoint này với dữ liệu thật.

## 8. Cấu trúc dữ liệu D1

- `trips`: mã trip, tên, trạng thái, thời gian tạo.
- `trip_members`: thành viên trong trip.
- `location_events`: tọa độ, tốc độ, độ chính xác và timestamp.

## 9. Bảo mật và vận hành

- Không hardcode Google API key.
- Secret dùng Wrangler secret hoặc `.env.local` không commit.
- ID ngẫu nhiên dùng Web Crypto.
- Giới hạn kích thước JSON và kiểm tra số liệu tọa độ.
- Thêm auth, rate limit, retention policy và privacy notice trước production.

## 10. Kiểm thử thiết bị

Kiểm tra trên Safari iPhone và Chrome Android:

- Cài PWA vào màn hình chính.
- GPS chính xác khi đang di chuyển.
- Wake Lock được cấp hoặc hiển thị fallback.
- Mất mạng và kết nối lại.
- App bị đưa nền hoặc màn hình khóa.
- Pin, nhiệt độ và độ trễ cập nhật.

## 11. Chi phí

Phase 0 chạy local, không phát sinh chi phí. Private beta có thể phát sinh Cloudflare và Google Maps theo mức dùng. Chưa tạo tài nguyên cloud trong task này.

## 12. Roadmap

1. Phase 0: technical proof of concept.
2. Phase 1: trip/member flow và realtime ổn định.
3. Phase 2: private beta 3–5 xe.
4. Phase 3: offline/reconnect, auth và privacy.
5. Phase 4: biển báo và speed-limit data được kiểm chứng.
6. Phase 5: public release hoặc native/hybrid nếu cần GPS nền.
