Trail thêm các nút ngay trên ô chat cho những gì một phiên agent đang làm: task của phiên, các merge request và pull request kèm trạng thái cập nhật liên tục, và khi cần, các file và trang mà phiên đã đụng tới. Mỗi nút mở ra một menu, nên link của một phiên dài vẫn chỉ cách một cú bấm.

## Có gì

- **Task.** Tài liệu hoặc issue mà phiên đang làm. Mở nó ở một tab chỉ đọc cạnh chat hoặc trên Git forge. Khi có `bundle: "siblings"` và task doc tên `<tên>/README.md`, các file Markdown khác trong thư mục (tối đa 20, xuống một cấp thư mục con) được liệt kê cùng.
- **Merge request và pull request.** Các MR GitLab và PR GitHub mà task doc ghi dạng URL (tối đa 20), mọi cái đã được ghim, cộng với năm cái khác phiên nhắc tới gần nhất, kèm trạng thái, CI, conflict, số commit behind và approve, cập nhật khoảng mỗi phút. Rebase, Update branch và Merge chỉ cần xác nhận một lần, và hộp xác nhận nêu request bằng project và số của nó.
- **File, tài liệu và link khác.** Ở chế độ tất cả link, mỗi nhóm giữ 15 mục gần nhất: file agent đã đọc hoặc sửa, trang trên các công cụ như Figma, Notion hay Google Docs, và các link khác trong hội thoại.

Chuyển giữa link của task và tất cả link trong menu nút Task, hoặc bằng `/trail-task` và `/trail-all`. `/trail-copy` chép các link thành danh sách Markdown; `/trail-pin` và `/trail-unpin` thêm hoặc bỏ một link. Mỗi lệnh để lại một dòng ghi chú ngắn trong hội thoại cho bạn xem; dòng này không được gửi cho agent.

## Cách hoạt động

Daemon đọc 300 tin nhắn mới nhất của phiên và ghi lại đường dẫn các file agent đã đọc hoặc sửa, cứ 30 giây một lần trong lúc agent chạy (tối đa ba giờ) và thêm một lần khi lượt kết thúc. Output của shell bị bỏ qua. Một tài liệu thành task khi bạn nhắc tên nó hoặc agent sửa nó. Agent Claude và Codex mới tạo được gắn MCP server `trail` có tool `pin_link` đã duyệt sẵn, kèm một hướng dẫn ngắn yêu cầu viết merge request và pull request dưới dạng URL hoặc `project!N` / `owner/repo#N`. Hướng dẫn này cũng dặn agent bắt đầu từ bản tóm tắt của một phiên fork tự ghim task và các request của phiên đó, vì Trail không đọc được bản tóm tắt. Hướng dẫn, mô tả của tool và kết quả mỗi lần gọi tool đều được gửi tới nhà cung cấp model của agent cùng phần còn lại của hội thoại.

## Thiết lập

Trail cần Paseo 0.13 trở lên, daemon chạy trên macOS hoặc Linux; Windows chưa được thử. `glab` và `gh` là tuỳ chọn.

Link hoạt động không cần thiết lập. Để nhận ra task doc và project trên GitLab tự host, thêm `.paseo/trail/config.json` vào dự án, hoặc giữ một file riêng ở `$PASEO_HOME/trail/config.json`. File của dự án chỉ được trỏ vào trong dự án; nơi đọc token, những host GitLab được dùng phiên đăng nhập `glab` của bạn, và mẫu mã task đều thuộc về file cá nhân. [Hướng dẫn cấu hình](https://github.com/ttquoccuong/paseo-trail/blob/main/docs/configuration.md) liệt kê đủ các field. File dự án vi phạm các quy tắc này bị bỏ qua, lý do hiện trong Settings, và file cá nhân được dùng thay.

Trạng thái và thao tác cần token: GitLab cần `read_api` để xem trạng thái và `api` để Rebase, Merge; token classic của github.com cần `repo` để Update branch và Merge. Trail tìm token dán trong Settings, Plugins, Trail trước, rồi tới những nơi config cá nhân và môi trường của daemon chỉ định, cuối cùng là phiên đăng nhập `glab` hoặc `gh`; hướng dẫn cấu hình ghi thứ tự chính xác. Màn hình cài đặt hiện trạng thái từng token và cách sửa khi thiếu, đồng thời cho chọn chế độ mặc định và ngôn ngữ giao diện (tiếng Anh hoặc tiếng Việt).

## Dữ liệu và quyền

- **Token.** Token chỉ được gửi tới đúng host mà nó được thiết lập cho, và không bao giờ đi theo chuyển hướng. Host GitLab chỉ được một link hoặc một file dự án nêu ra thì không nhận token nào và không bị gọi tới, cho tới khi bạn dán token cho nó hoặc thêm nó vào config cá nhân; Settings đánh dấu những host như vậy để bạn không dán token nhầm. Ngoại lệ duy nhất là `GITLAB_TOKEN`, được gửi tới host mà `GITLAB_HOST` chỉ định, hoặc gitlab.com khi biến này không được đặt. Token đã dán nằm trên máy chạy daemon, chỉ user chạy daemon đọc được.
- **Thao tác.** Rebase, Update branch và Merge đều hỏi xác nhận, và Merge bị từ chối nếu nhánh hoặc cài đặt merge đã thay đổi sau lần đọc trạng thái.
- **Request.** Request lấy trạng thái tới mọi forge dùng chung bốn slot, việc kiểm token có thêm hai slot riêng, mỗi request có giới hạn thời gian, và request lỗi không bị hỏi lại ở mỗi lần poll. Trail chỉ theo dõi một số lượng có hạn các host GitLab bạn chưa thiết lập; quá số đó thì host hiện là thừa và không bao giờ bị gọi tới. Các con số nằm trong README.
- **File.** Bản xem file chỉ đọc thư mục task và các file agent đã đụng tới, tối đa 512 KB. Trail giữ các file của mình (config cá nhân, link đã thu thập, lựa chọn theo từng phiên, token đã lưu) trong `$PASEO_HOME/trail`; hai mục cài đặt nằm trong phần cài đặt của chính Paseo, còn dòng ghi chú của mỗi lệnh nằm trong timeline của agent.
- **Đọc thêm.** Để tìm thư mục của chính nó, Trail đọc `$PASEO_HOME/config.json` của Paseo và `paseo-plugin.json` của các plugin được liệt kê ở đó, và chạy `git rev-parse` trong thư mục làm việc của agent để lấy tên nhánh.

## Giới hạn

GitHub chỉ hỗ trợ github.com. Agent tạo trước khi cài Trail không có tool `pin_link`, và phiên fork bắt đầu với thanh nút trống cho tới khi agent của nó ghim task. `!N` hoặc `#N` đứng một mình không thành link.
