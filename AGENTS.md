# Group Navigation

Đây là quy trình Anto Fix cho repository.

1. Đọc phạm vi, file liên quan và trạng thái git trước khi sửa.
2. Liệt kê caller, test, fixture, config và export bị ảnh hưởng.
3. Sửa nguyên nhân gốc bằng diff nhỏ nhất.
4. Chạy kiểm tra phù hợp trước khi báo hoàn tất.
5. Không deploy, không tạo tài nguyên trả phí, không dùng dữ liệu thật nếu chưa được yêu cầu.

Phạm vi Phase 0: React/Vite/TypeScript PWA, Worker, Durable Object, D1 schema, Google Maps loader, GPS foreground, Wake Lock và ngưỡng tốc độ thủ công. Biển báo và giới hạn tốc độ là phase sau.

Không commit secret, dữ liệu vị trí thật hoặc database ID thật.
