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

## Google sign-in for trip leaders

Only trip creators sign in with Google. Joining by trip code remains public.
The Worker verifies Google signatures, audience, issuer, expiration, and verified email.
Trip ownership uses Google's stable `sub`, never a browser-supplied email.
Google ID tokens stay in sessionStorage and expire; sign in again when requested.
Existing trips retain their existing device credential. They are not reassigned automatically.

Before deploying this version, apply `db/migrations/0004_google_leader.sql` to D1.
Add these JavaScript origins to the configured Google web OAuth client:

- https://weemap.antony.codes
- https://group-navigation-local.eventnpi2026.workers.dev
- http://localhost:5173

Use `http://localhost:5173` for local testing, not the numeric loopback address.
The OAuth client ID is public configuration. No client secret is needed by this flow.

## Route from GPS to a Plus Code

Use the route icon on the map. The departure point is the device's current GPS fix.
Paste a full Plus Code, preview the destination pin, then request the driving route.
Bare short codes resolve nearest to current GPS; always confirm the destination pin.
Short codes with locality text need a full code instead; no geocoder is used.
Routing sends the two coordinates to openrouteservice through the Worker.
The ORS_API_KEY stays on the Worker. Routes are snapshots, without automatic rerouting.
The public directions endpoint validates coordinates and uses a Durable Object quota:
10 seconds between attempts, 60 requests per IP per UTC day, 600 globally per UTC day.
Quota storage contains hashed IP identifiers and counters, not route coordinates.
Deploy the updated Worker before using this frontend online. No D1 migration is required.
