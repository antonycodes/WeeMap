# Group Navigation

PoC PWA cho private beta 3–5 xe.

## Bắt đầu local

```bash
npm install
cp .env.example .env.local
npm run dev
```

Mở `http://localhost:5173`. Chạy thêm `npm run cf:dev` ở terminal thứ hai để bật Worker local. Không cần Google key để xem checklist và fallback map. Thêm `VITE_GOOGLE_MAPS_API_KEY` để bật Google Maps.

Để kiểm tra WebSocket và D1 local:

```bash
curl -X POST http://127.0.0.1:8787/api/trips \
  -H 'content-type: application/json' \
  -d '{"name":"PoC test"}'
```

Mở `http://localhost:5173/?trip=<id>` bằng `id` trả về. Không dùng mã này với dữ liệu thật.

## Kiểm tra

```bash
npm test
npm run cf:types
npm run build
```

`cf:types` tạo type binding từ `wrangler.jsonc`. Chạy lại sau mỗi thay đổi binding.

## Cloudflare local

```bash
npm run build
npx wrangler d1 execute group-navigation-local --local --file=db/schema.sql
npm run cf:dev
```

`wrangler.jsonc` đang trỏ tới Worker và D1 đang triển khai. Kiểm tra tài khoản Cloudflare và binding trước khi chạy lệnh ghi dữ liệu remote.

## Khoảng cách theo đường đi

Tạo `.dev.vars` từ `.dev.vars.example`, rồi điền `ORS_API_KEY` của openrouteservice. File chứa khóa được bỏ qua bởi Git. Trên production, lưu khóa bằng `npx wrangler secret put ORS_API_KEY`; không dùng biến `VITE_` cho khóa này.

Worker tính khoảng cách và thời gian theo tuyến ô tô giữa các xe có GPS cập nhật trong 45 giây gần nhất. Một ma trận được dùng chung cho cả đoàn trong 60 giây, kể cả khi Durable Object khởi động lại. Client kiểm tra kết quả mỗi 30 giây khi app đang mở. API yêu cầu token thành viên hợp lệ.

Thời gian là ước tính theo tuyến ô tô, chưa tính giao thông trực tiếp. Khi GPS cũ, hết hạn mức hoặc không tìm được đường, app không hiển thị thời gian; khoảng cách đường thẳng được ghi rõ nếu còn GPS mới. API key gói miễn phí vẫn chịu hạn mức chung của openrouteservice cho mọi chuyến.

## Giới hạn PoC

- Chưa có auth, rate limit hoặc privacy retention.
- Chưa đảm bảo GPS khi app chạy nền hoặc màn hình khóa.
- Chưa có biển báo, giới hạn tốc độ pháp lý hoặc turn-by-turn navigation.
- Không dùng dữ liệu vị trí thật.
