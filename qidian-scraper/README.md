# qidian-scraper (thử nghiệm)

Mở một chương Qidian bằng Chrome thật, dùng bản sao cookie từ profile Chrome đã
đăng nhập, rồi lấy text chương.

```bash
uv run scrape.py "https://www.qidian.com/chapter/<book_id>/<chapter_id>/" --out chapter.txt
# tuỳ chọn: --profile "Profile 1"  --user-data-dir "<...>\Google\Chrome\User Data"  --dump page.html
```

- Mặc định đọc profile ở `%LOCALAPPDATA%\Google\Chrome\User Data` (hoặc biến `CHROME_USER_DATA`).
- Profile được copy sang một thư mục tạm riêng của lần chạy và tự xoá khi xong.
- Chương dùng font mã hoá (`r-font-encrypt`) không được lưu (exit code 2), vì text
  trong DOM sai chữ. Với chương đó, dùng extension chụp màn hình + `qidian-ocr`.
