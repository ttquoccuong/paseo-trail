Trail thêm các nút ngay trên ô chat cho những gì một phiên agent đang làm: task của phiên và checklist những việc task cần, các merge request và pull request kèm trạng thái cập nhật liên tục, và khi cần, các file và trang mà phiên đã đụng tới. Mỗi nút mở ra một menu, nên link của một phiên dài vẫn chỉ cách một cú bấm.

## Có gì

- **Task.** Tài liệu hoặc issue mà phiên đang làm. Mở nó ở một tab chỉ đọc cạnh chat hoặc trên Git forge. Khi có `bundle: "siblings"` và task doc tên `<tên>/README.md`, các file Markdown khác trong thư mục (tối đa 20, xuống một cấp thư mục con) được liệt kê cùng.
- **Checklist.** Nằm trên menu của nút Task: những việc task chính của phiên cần làm, theo thứ tự, mỗi mục ở một trạng thái: chưa làm, đang làm, đang chờ, xong hoặc bỏ. Agent ghi lý do cho từng mục, ghi bằng chứng khi một mục xong và đang chờ ai khi một mục phải chờ, và bạn đọc các ghi chú đó trong một popover. Nút hiện tiến độ, ví dụ `Task 2/5`, và chuyển màu vàng khi có mục đang chờ người khác. Task giao chỉ qua chat cũng có list, việc phụ không được thêm vào nên list vẫn chỉ đường quay lại sau khi rẽ ngang, và list đã xong được cất đi khi phiên chuyển sang việc khác.
- **Merge request và pull request.** Các MR GitLab và PR GitHub mà task doc ghi dạng URL (tối đa 20), mọi cái đã được ghim, cộng với năm cái khác phiên nhắc tới gần nhất, kèm trạng thái, CI, conflict, số commit behind và approve, cập nhật khoảng mỗi phút. Rebase, Update branch và Merge chỉ cần xác nhận một lần, và hộp xác nhận nêu request bằng project và số của nó.
- **File, tài liệu và link khác.** Ở chế độ tất cả link, mỗi nhóm giữ 15 mục gần nhất: file agent đã đọc hoặc sửa, trang trên các công cụ như Figma, Notion hay Google Docs, và các link khác trong hội thoại.

Chuyển giữa link của task và tất cả link trong menu nút Task, hoặc bằng `/trail-task` và `/trail-all`. `/trail-copy` chép các link thành danh sách Markdown; `/trail-pin` và `/trail-unpin` thêm hoặc bỏ một link. Mỗi lệnh để lại một dòng ghi chú ngắn trong hội thoại cho bạn xem; dòng này không được gửi cho agent.

## Cách hoạt động

Daemon đọc 300 tin nhắn mới nhất của phiên và ghi lại đường dẫn các file agent đã đọc hoặc sửa, cứ 30 giây một lần trong lúc agent chạy (tối đa ba giờ) và thêm một lần khi lượt kết thúc. Output của shell bị bỏ qua. Khi agent chưa ghim hay đặt tên task, Trail tự đoán: tài liệu bạn nhắc tới nặng ký nhất (chia đều cho các tài liệu cùng một tin nhắn, gấp đôi ở tin nhắn đầu tiên của phiên), rồi tới tài liệu agent sửa, còn tài liệu agent chỉ đọc hoặc nhắc tới thì nhẹ; bằng chứng cũ nhạt dần khi phiên chuyển việc. Khi có tài liệu khác sát điểm, nút hiện `Task?` và menu cho bạn chọn đúng task. Agent Claude Code mới tạo được gắn MCP server `trail` có bốn tool đã duyệt sẵn: `pin_link` đặt task và thêm link, còn `set_main_task`, `add_checklist_item` và `update_checklist_item` giữ checklist. Một hướng dẫn ngắn dặn agent ghim task ngay khi bạn nêu task, lập list những việc task cần trước khi sửa file, báo tiến độ trong lúc làm, và viết merge request và pull request dưới dạng URL hoặc `project!N` / `owner/repo#N`. Agent bắt đầu từ bản tóm tắt của một phiên fork được dặn tự ghim task và các request của phiên đó và chép lại checklist, vì Trail không đọc được bản tóm tắt. Hướng dẫn, mô tả của các tool và kết quả mỗi lần gọi tool đều được gửi tới nhà cung cấp model của agent cùng phần còn lại của hội thoại.

Agent khởi chạy server đó qua `$PASEO_HOME/trail/bin/trail-mcp.mjs`, một file khởi chạy tra bản cài hiện tại trong registry plugin của Paseo, nên phiên vẫn giữ tool khi một lần update chuyển plugin sang thư mục mới.

Paseo không cho plugin hook nào chạy theo từng tin nhắn. Nếu dùng Claude Code, bạn có thể thêm `bin/trail-reminder.mjs` làm hook `UserPromptSubmit` trong settings Claude Code của mình: trước mỗi tin nhắn của bạn, nó cho agent một dòng về tình trạng checklist. README có sẵn cấu hình; dòng này được gửi tới nhà cung cấp model cùng tin nhắn của bạn.

## Thiết lập

Trail cần Paseo 0.13 trở lên, daemon chạy trên macOS hoặc Linux; Windows chưa được thử. Agent chỉ được thử với Claude Code. `glab` và `gh` là tuỳ chọn.

Link hoạt động không cần thiết lập. Để nhận ra task doc và project trên GitLab tự host, thêm `.paseo/trail/config.json` vào dự án, hoặc giữ một file riêng ở `$PASEO_HOME/trail/config.json`. File của dự án chỉ được trỏ vào trong dự án; nơi đọc token, những host GitLab được dùng phiên đăng nhập `glab` của bạn, và mẫu mã task đều thuộc về file cá nhân. [Hướng dẫn cấu hình](https://github.com/ttquoccuong/paseo-trail/blob/main/docs/configuration.md) liệt kê đủ các field. File dự án vi phạm các quy tắc này bị bỏ qua, lý do hiện trong Settings, và file cá nhân được dùng thay.

Trạng thái và thao tác cần token: GitLab cần `read_api` để xem trạng thái và `api` để Rebase, Merge; token classic của github.com cần `repo` để Update branch và Merge. Trail tìm token dán trong Settings, Plugins, Trail trước, rồi tới những nơi config cá nhân và môi trường của daemon chỉ định, cuối cùng là phiên đăng nhập `glab` hoặc `gh`; hướng dẫn cấu hình ghi thứ tự chính xác. Màn hình cài đặt hiện trạng thái từng token và cách sửa khi thiếu, đồng thời cho chọn chế độ mặc định và ngôn ngữ giao diện (tiếng Anh hoặc tiếng Việt).

## Dữ liệu và quyền

- **Token.** Token chỉ được gửi tới đúng host mà nó được thiết lập cho, và không bao giờ đi theo chuyển hướng. Host GitLab chỉ được một link hoặc một file dự án nêu ra thì không nhận token nào và không bị gọi tới, cho tới khi bạn dán token cho nó hoặc thêm nó vào config cá nhân; Settings đánh dấu những host như vậy để bạn không dán token nhầm. Ngoại lệ duy nhất là `GITLAB_TOKEN`, được gửi tới host mà `GITLAB_HOST` chỉ định, hoặc gitlab.com khi biến này không được đặt. Token đã dán nằm trên máy chạy daemon, chỉ user chạy daemon đọc được.
- **Thao tác.** Rebase, Update branch và Merge đều hỏi xác nhận, và Merge bị từ chối nếu nhánh hoặc cài đặt merge đã thay đổi sau lần đọc trạng thái.
- **Request.** Request lấy trạng thái tới mọi forge dùng chung bốn slot, việc kiểm token có thêm hai slot riêng, mỗi request có giới hạn thời gian, và request lỗi không bị hỏi lại ở mỗi lần poll. Trail chỉ theo dõi một số lượng có hạn các host GitLab bạn chưa thiết lập; quá số đó thì host hiện là thừa và không bao giờ bị gọi tới. Các con số nằm trong hướng dẫn cấu hình.
- **File.** Bản xem file chỉ đọc thư mục task và các file agent đã đụng tới, tối đa 512 KB. Trail giữ các file của mình (config cá nhân, link đã thu thập, checklist và lựa chọn của từng phiên, token đã lưu, và file khởi chạy MCP trong `bin/`) trong `$PASEO_HOME/trail`; hai mục cài đặt nằm trong phần cài đặt của chính Paseo, còn dòng ghi chú của mỗi lệnh nằm trong timeline của agent.
- **Đọc thêm.** Để tìm thư mục của chính nó, Trail đọc `$PASEO_HOME/config.json` của Paseo và `paseo-plugin.json` của các plugin được liệt kê ở đó, và chạy `git rev-parse` trong thư mục làm việc của agent để lấy tên nhánh.

## Giới hạn

GitHub chỉ hỗ trợ github.com. Agent tạo trước khi cài Trail không có tool nào của Trail, và agent tạo trước một lần update thiếu các tool bản đó thêm vào; chúng vẫn chạy được các tool đó từ shell bằng `node <thư mục plugin hiện tại>/bin/trail-task.mjs <tool> '<json>'`. Phiên tạo trên 0.1.0 mất tool của Trail sau khi update từ Git hoặc registry; hãy mở phiên mới. Phiên fork bắt đầu với thanh nút trống cho tới khi agent của nó ghim task. `!N` hoặc `#N` đứng một mình không thành link. Agent viết checklist; muốn đổi thì bạn bảo agent.
