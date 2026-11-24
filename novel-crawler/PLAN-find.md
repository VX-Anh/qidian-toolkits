# Plan: `novel-crawler find "<tên truyện>"` — đưa tên, tự tìm và lấy full txt

Trạng thái: **GĐ 1–4 đã làm (24/11/2026), GĐ 5 chưa**. Ngày viết: 24/11/2026.

Owner bảo "thực hiện" mà chưa chốt mục 7 → dùng mặc định: có nhận tên Việt (Claude CLI); tự chọn
khi chắc, chỉ hỏi khi các nguồn khác tác giả (`--yes` để luôn tự chọn); chưa upload VietPhase;
mirror Biquge không cấu hình cố định mà lấy từ kết quả tìm kiếm.

**Thay đổi so với plan khi làm:** không dùng ô tìm kiếm của từng trang. 69shu bắt giải Turnstile mỗi
lần tìm (không tự động được), trang kết quả 17k bị chống bot làm trống. Thay bằng Bing qua Chrome
(`<tên> 69书吧 / 笔趣阁 / 17k小说网 / 纵横中文网`, thị trường en-US vì zh-CN lọc trang raw; toán tử
`site:` cho kết quả thất thường nên không dùng), DuckDuckGo HTML dự phòng. Không có `mirrors.toml`
và `mirrors check`: mirror lấy thẳng từ kết quả tìm kiếm, mirror chết bị loại khi kiểm ứng viên.

## 1. Mục tiêu

```bash
uv run novel-crawler find "凡人修仙传"            # tên Trung
uv run novel-crawler find "Phàm Nhân Tu Tiên"     # tên Việt (giai đoạn 3)
```

Kết quả: thư mục sách với `chapters/第N章 *.txt` (để upload VietPhase) và một file txt gộp đầy đủ,
kèm báo cáo: lấy từ nguồn nào, bao nhiêu chương, thiếu chương nào.

## 2. Hiện trạng (đã kiểm 24/11)

- Tool chỉ nhận link (`get`, `info`, `update`, `merge`, `tieba`). Chưa có tìm kiếm.
- Tải theo link đã chạy thật trên 17k, Zongheng, 69shu, Biquge (bigee.cc).
- Dò nhanh ô tìm kiếm của từng nguồn:

| Nguồn | Tìm kiếm | Ghi chú |
|---|---|---|
| 69shu | form `POST /modules/article/search.php`, trường `searchkey` | Cloudflare → đi qua Chrome; tên phải mã hoá GBK |
| bigee.cc (Biquge) | `/user/search.html` trả 404 | mỗi mirror một kiểu, có mirror không cho tìm |
| 17k | `search.17k.com/search.xhtml?c.q=` trả HTML (gzip) | tìm 凡人修仙传 không ra: sách Qidian không có trên 17k |
| Zongheng | `search.zongheng.com/s?keyword=` là trang JS | cần tìm API phía sau hoặc dùng Chrome |

**Nhận xét quan trọng:** truyện nổi tiếng thường là của Qidian, nên chỉ có trên 69shu và Biquge.
17k và Zongheng chỉ có truyện gốc của chính họ, và phần lớn chương là VIP. Vì vậy **nguồn chính
để lấy full là 69shu + Biquge**. 17k/Zongheng là nguồn phụ, chỉ dùng khi truyện là truyện gốc ở đó.

## 3. Luồng xử lý

```
tên ──► (3a) chuẩn hoá tên ──► (3b) tìm song song trên các nguồn ──► (3c) khớp + xếp hạng
                                                                            │
     báo cáo ◄── (3e) gộp + kiểm tra ◄── (3d) tải từ nguồn tốt nhất (vá chỗ thiếu từ nguồn khác)
```

### 3a. Chuẩn hoá tên
- Tên Trung: bỏ dấu câu, khoảng trắng; đổi phồn thể → giản thể (thư viện `opencc`).
- Tên Việt (giai đoạn 3): gọi Claude Code CLI headless (`claude -p`, đúng quy ước chỉ dùng client
  chính thức) để ra 1–3 tên Trung ứng viên + tác giả. Lưu cache `~/.novel-crawler/names.json`
  để lần sau không hỏi lại. Owner có thể ghi đè bằng `--zh "凡人修仙传"`.

### 3b. Tìm kiếm (mỗi adapter thêm hàm `search(query) -> list[Candidate]`)
`Candidate = {site, title, author, url, latest_chapter, status(连载/完本)}`
- **69shu:** gửi form tìm kiếm trong Chrome (gõ vào ô, bấm tìm). Nếu chỉ có một kết quả,
  trang thường nhảy thẳng tới sách. Cần đo giới hạn tần suất tìm kiếm (nhiều trang 69shu chặn
  tìm liên tục trong vài chục giây).
- **Biquge:** file cấu hình `mirrors.toml` liệt kê các mirror còn sống kèm mẫu URL tìm kiếm và
  selector kết quả. Lệnh `novel-crawler mirrors check` kiểm mirror nào còn sống / còn tìm được.
  Bắt đầu với 2–3 mirror (dò lúc làm).
- **17k:** đọc HTML kết quả (nhớ giải nén gzip).
- **Zongheng:** tìm API JSON mà trang tìm kiếm gọi; không có thì dùng Chrome.
- Chạy song song theo nguồn, mỗi nguồn timeout 60 giây. Một nguồn lỗi thì vẫn dùng các nguồn còn lại.

### 3c. Khớp và xếp hạng
1. Lọc: tên sau chuẩn hoá phải trùng hẳn (hoặc gần trùng, chỉ khác dấu câu). Biết tác giả thì
   tác giả cũng phải trùng.
2. Với tối đa 3 ứng viên đầu, đọc mục lục (mỗi cái 1 request) để biết số chương **tải được**
   (trừ chương VIP).
3. Điểm = số chương tải được (chính), cập nhật gần đây, nguồn ổn định (69shu > Biquge > 17k/Zongheng).
4. **Chống nhầm sách trùng tên:** so tiêu đề 5 chương đầu giữa các nguồn. Lệch nhiều thì coi là
   sách khác.
5. Không chắc chắn (nhiều ứng viên ngang điểm, khác tác giả) thì in danh sách để chọn bằng số;
   `--yes` để tự chọn cái điểm cao nhất.

### 3d. Tải
- Dùng lại `download()` hiện có trên nguồn thắng.
- **Vá chỗ thiếu (giai đoạn 4):** chương lỗi hoặc thiếu ở nguồn chính thì tìm chương cùng số ở
  nguồn thứ hai (đối chiếu theo số chương lấy từ tiêu đề), tải bù.

### 3e. Gộp và báo cáo
- Gộp thành 1 file txt như `merge`.
- Báo cáo: nguồn đã dùng, tổng chương, dãy số chương bị hụt (ví dụ thiếu 第312章), chương quá ngắn
  (nghi lỗi), ghi vào `report.txt` trong thư mục sách.

## 4. Giai đoạn

| GĐ | Nội dung | Xong khi |
|---|---|---|
| 1 | `search` cho 69shu + 2 mirror Biquge; lệnh `find` in danh sách ứng viên, chọn bằng số rồi tải | Tìm và tải được 3 truyện mẫu bằng tên Trung |
| 2 | Xếp hạng tự động, `--yes`, chống nhầm sách, gộp + `report.txt` | `find "<tên>" --yes` ra full txt không cần thao tác |
| 3 | Nhận tên Việt qua Claude CLI + cache; `--zh` ghi đè | Tên Việt của 3 truyện mẫu ra đúng tên Trung |
| 4 | Tìm trên 17k/Zongheng; vá chương thiếu từ nguồn thứ hai; `mirrors check` | Truyện có lỗ hổng ở nguồn chính được vá đủ |
| 5 (tuỳ chọn) | Upload thẳng lên VietPhase qua `/api/chapters/upload` (cần `API_TOKEN`) | Chương xuất hiện trong read.aico mà không phải upload tay |

## 5. Kiểm thử

- Test parser trang kết quả tìm kiếm bằng HTML tự viết (như test hiện có).
- Test khớp tên: phồn/giản thể, dấu câu, trùng tên khác tác giả.
- Chạy thật với 3 truyện mẫu: một truyện Qidian nổi tiếng (chỉ có trên 69shu/Biquge), một truyện
  gốc 17k, một truyện gốc Zongheng.

## 6. Rủi ro

- Mirror Biquge chết hoặc đổi kiểu trang liên tục → phải bảo trì `mirrors.toml`; `mirrors check` để phát hiện sớm.
- 69shu giới hạn tần suất tìm kiếm, Cloudflare đổi cách kiểm tra → chế độ Chrome chờ người dùng như hiện nay.
- Tên Việt → Trung có thể sai, nhất là tên dịch thoáng → luôn in tên Trung đã dùng, cho `--zh` ghi đè.
- 17k/Zongheng: phần VIP không lấy được. Truyện gốc ở đó mà 69shu/Biquge không có thì sẽ không đủ full; báo cáo ghi rõ.

## 7. Cần owner chốt

1. **Tên tiếng Việt:** có làm giai đoạn 3 không, hay luôn đưa tên Trung?
2. **Nhiều ứng viên:** mặc định hỏi chọn bằng số, hay mặc định tự chọn (`--yes` thành mặc định)?
3. **Upload VietPhase (giai đoạn 5):** có cần không?
4. **Mirror Biquge:** có mirror quen dùng không? Không có thì mình tự chọn vài mirror còn sống.
