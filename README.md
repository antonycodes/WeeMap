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

`wrangler.jsonc` đang dùng database ID placeholder. Không deploy file này. Tạo D1 thật và thay ID chỉ sau khi có quyết định triển khai.

## Giới hạn PoC

- Chưa có auth, rate limit hoặc privacy retention.
- Chưa đảm bảo GPS khi app chạy nền hoặc màn hình khóa.
- Chưa có biển báo, giới hạn tốc độ pháp lý hoặc turn-by-turn navigation.
- Không dùng dữ liệu vị trí thật.
