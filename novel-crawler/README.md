# novel-crawler

Tải bản raw truyện Trung thành file `.txt` từng chương, đặt tên theo mẫu VietPhase đọc được
(`第12章 风起.txt`) → upload thẳng vào read.aico.io.vn.

| Nguồn | Cách tải | Ghi chú |
|---|---|---|
| 17k (17k.com) | HTTP | chỉ chương miễn phí, chương VIP tự bỏ qua |
| Zongheng (zongheng.com) | HTTP | chỉ chương miễn phí |
| 69shu (69shuba.com…) | Chrome | có Cloudflare; thường tự qua, không cần bấm |
| Biquge (mọi mirror) | HTTP → tự chuyển Chrome nếu bị chặn | adapter đoán selector, dùng được cho hầu hết trang raw kiểu cũ |
| Tieba (tieba.baidu.com/p/…) | Chrome | Baidu hiện captcha → tự giải 1 lần trong cửa sổ Chrome |

## Cài

```bash
cd novel-crawler
uv sync
# Chế độ Chrome dùng Chrome đã cài trên máy. Không có Chrome thì:
#   uv run playwright install chromium   và thêm --channel chromium
```

## Đưa tên, tự lấy full

```bash
uv run novel-crawler find "凡人修仙传"                 # tên Trung
uv run novel-crawler find "Phàm Nhân Tu Tiên"          # tên Việt → Claude CLI đoán tên Trung
uv run novel-crawler find "人道大圣" --author 莫默 --yes  # lọc tác giả, không hỏi
uv run novel-crawler find "凡人修仙传" --dry-run         # chỉ xem chọn nguồn nào, không tải
```

Tool làm lần lượt:
1. **Tên Việt → tên Trung:** gọi `claude -p` (Claude Code CLI đã đăng nhập), lưu cache ở
   `~/.novel-crawler/names.json`. Đoán sai thì dùng `--zh "<tên Trung>"`.
2. **Tìm:** Bing (mở bằng Chrome) với 4 câu `<tên> 69书吧 / 笔趣阁 / 17k小说网 / 纵横中文网`,
   DuckDuckGo dự phòng. Chỉ giữ kết quả đúng tên (không nhận 凡人修仙传：xxx, 凡人修仙之仙界篇).
   Bỏ qua trang chính thống không có bản raw (qidian, qimao, shuqi...).
3. **Kiểm ứng viên:** đọc mục lục tối đa 8 nguồn (trang kẹt màn kiểm tra > 20 giây thì bỏ qua),
   đếm chương tải được, gom nhóm theo 5 chương đầu để loại sách trùng tên.
4. **Chọn:** nhiều chương tải được nhất, hoà thì 69shu > Biquge > 17k/Zongheng; tải thử 1 chương
   trước khi chốt. Các nguồn khác tác giả nhau thì hỏi chọn (trừ khi `--yes`).
5. **Tải + vá:** tải từ nguồn chính, chương lỗi lấy bù từ nguồn phụ theo số chương.
6. **Kết quả:** `chapters/*.txt`, file gộp `<tên>.txt`, và `report.txt` (nguồn, số chương, chương
   thiếu, số chương bị nhảy, chương ngắn bất thường).

Vì sao tìm qua Bing mà không dùng ô tìm kiếm của trang: 69shu bắt giải Cloudflare Turnstile mỗi lần
tìm, trang kết quả 17k bị chống bot làm trống, mirror Biquge mỗi cái một kiểu.

## Dùng theo link

```bash
# Tải cả truyện (link trang sách, mục lục hay một chương đều được)
uv run novel-crawler get https://www.69shuba.com/book/58831.htm
uv run novel-crawler get https://www.17k.com/book/3632497.html --from 1 --to 100
uv run novel-crawler get https://www.bigee.cc/book/6909/ --merge   # tải xong gộp 1 file

# Xem trước: tên sách, số chương, bao nhiêu chương VIP
uv run novel-crawler info https://www.zongheng.com/book/1416170.html

# Tải chương mới cho mọi sách đã tải (hoặc chỉ định thư mục sách)
uv run novel-crawler update
uv run novel-crawler update "downloads/69shu_58831 七零，我成了年代文里的恶毒女配"

# Gộp thành 1 file
uv run novel-crawler merge "downloads/17k_3632497 让你演死尸，谁叫你起来破案的？"

# Tieba: chỉ lấy bài chủ thread, bỏ tầng < 200 chữ; --split = mỗi tầng 1 file chương
uv run novel-crawler tieba https://tieba.baidu.com/p/1234567890 --split
```

Tuỳ chọn chung: `--out DIR` (mặc định `./downloads`), `--delay 1.2` (giây giữa 2 request),
`--browser` / `--http` (ép cách tải), `--headless`, `--profile DIR`, `--channel chrome|msedge|chromium`.

Chạy lại cùng lệnh = tải tiếp phần còn thiếu (Ctrl+C an toàn). Trạng thái ở `book.json`.

## Kết quả

```
downloads/69shu_58831 七零，我成了年代文里的恶毒女配/
  book.json                  # link mục lục, danh sách chương, file đã tải
  chapters/第1章 穿越预警.txt   # dòng 1 = tiêu đề, sau đó các đoạn cách nhau 1 dòng trống
  七零，我成了年代文里的恶毒女配.txt   # khi dùng --merge / merge
```

Số chương trong tên file: lấy từ tiêu đề (`第十二章` → 12). Chương không số (序章, 感言…) dùng lại
số của chương trước (0 nếu đứng đầu); quyển mới đánh lại từ 1 thì nối tiếp số trước.

## Chế độ Chrome

- Dùng profile **riêng** ở `~/.novel-crawler/chrome-profile`, không đụng Chrome hằng ngày.
- Gặp màn kiểm tra (Cloudflare, 百度安全验证…) tool chờ tối đa 3 phút để bạn tự bấm trong cửa sổ;
  cookie được giữ cho lần sau. Tool không tự giải captcha.
- Tieba: thread bị ẩn bớt tầng khi chưa đăng nhập → đăng nhập Baidu một lần trong cửa sổ đó.

## Thêm mirror / sửa khi trang đổi giao diện

- Mirror Biquge khác kiểu: thêm selector vào `CATALOG_SEL` / `CONTENT_SEL` trong
  `novel_crawler/sites/biquge.py`.
- Tên miền 69shu mới: thêm vào `Shu69.domains` (`sites/shu69.py`).
- Trang mới hẳn: viết lớp con `Site` (xem `sites/k17.py`, ~50 dòng) và thêm vào `SITES`
  trong `sites/__init__.py` (trước `Biquge`).

## Test

```bash
uv run --group dev pytest -q
```

Lưu ý: chỉ tải chương công khai miễn phí, dùng đọc cá nhân; giữ `--delay` hợp lý để không dội
trang nguồn. Tool không vượt paywall chương VIP.
