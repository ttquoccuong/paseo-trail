Trail 在聊天输入框上方为 agent 会话正在处理的内容添加按钮：它的任务、带实时状态的 merge request 和 pull request，以及在需要时，会话接触过的文件和页面。每个按钮都会打开一个菜单，即使会话很长，相关链接也只需一次点击。

## 功能

- **任务。** 会话正在处理的文档或 issue。可以在聊天旁的只读标签页中打开它，也可以在 Git 托管平台上打开。当设置了 `bundle: "siblings"` 且任务文档名为 `<名称>/README.md` 时，同一文件夹中的其他 Markdown 文件（最多 20 个，包含一级子文件夹）会一并列出。
- **Merge request 和 pull request。** 任务文档中以 URL 形式写出的 GitLab MR 和 GitHub PR（最多 20 个）、所有已固定的，以及会话最近提到的另外五个，显示状态、CI、冲突、落后的提交数和审批情况，大约每分钟刷新一次。Rebase、Update branch 和 Merge 只需确认一次，确认框会以项目和编号说明所操作的请求。
- **文件、文档和其他链接。** 在“全部链接”模式下，每类各保留最近的 15 项：agent 读取或编辑过的文件、Figma、Notion 或 Google Docs 等工具上的页面，以及对话中的其他链接。

可以在任务按钮的菜单中，或使用 `/trail-task` 和 `/trail-all`，在“仅任务链接”和“全部链接”之间切换。`/trail-copy` 会把这些链接复制为 Markdown 列表，`/trail-pin` 和 `/trail-unpin` 用于添加或移除单个链接。每条命令都会在对话中留下一条简短提示供你查看，这条提示不会发送给 agent。

## 工作方式

在 agent 运行期间，daemon 每 30 秒（最长三小时）读取一次会话最新的 300 条消息，并记录 agent 读取或编辑过的文件路径，每轮结束时再读取一次。Shell 输出会被忽略。当你提到某个文档或 agent 编辑了它时，该文档就会成为任务。新建的 Claude 和 Codex agent 会获得一个名为 `trail` 的 MCP server，其中包含预先批准的 `pin_link` 工具，以及一条简短说明，要求以 URL 或 `project!N` / `owner/repo#N` 的形式书写 merge request 和 pull request。说明还要求从 fork 会话摘要开始的 agent 自行固定原会话的任务和请求，因为 Trail 无法读取该摘要。这条说明、该工具的描述以及每次调用的结果，都会随对话的其余内容一起发送给 agent 的模型提供商。

## 设置

Trail 需要 Paseo 0.13 或更高版本，daemon 运行在 macOS 或 Linux 上；未在 Windows 上测试。`glab` 和 `gh` 为可选。

链接功能无需设置。要识别任务文档和自托管 GitLab 上的项目，可以在项目中添加 `.paseo/trail/config.json`，或在 `$PASEO_HOME/trail/config.json` 保存一份个人配置。项目配置只能指向项目内部；token 的读取位置、哪些 GitLab 主机可以使用你的 `glab` 登录，以及任务 ID 的匹配规则，都只能写在个人配置中。[README](https://github.com/ttquoccuong/paseo-trail#configuration) 列出了所有字段。违反这些规则的项目配置会被忽略，原因显示在设置中，并改用个人配置。

查看状态和执行操作需要 token：GitLab 查看状态需要 `read_api`，Rebase 和 Merge 需要 `api`；github.com 的 classic token 需要 `repo` 才能执行 Update branch 和 Merge。Trail 首先查找在 Settings、Plugins、Trail 中粘贴的 token，然后查找个人配置和 daemon 环境变量指定的位置，最后是 `glab` 或 `gh` 的登录信息；具体顺序见 README。设置页面会显示每个 token 的状态以及缺失时的解决方法，也可以设置默认模式和界面语言（英语或越南语）。

## 数据与权限

- **Token。** token 只会发送到为其配置的主机，并且不会跟随重定向。只由链接或项目配置提到的 GitLab 主机不会获得任何 token，也不会被访问，直到你为它粘贴 token 或将它加入个人配置；设置页面会标出这类主机，避免误粘贴 token。唯一的例外是 `GITLAB_TOKEN`：它会发送到 `GITLAB_HOST` 指定的主机，未设置时则为 gitlab.com。粘贴的 token 保存在运行 daemon 的机器上，只有运行 daemon 的用户可以读取。
- **操作。** Rebase、Update branch 和 Merge 都需要确认；如果分支或合并设置在读取状态之后有变动，Merge 会被拒绝。
- **请求。** 对所有托管平台的状态请求共用四个槽位，token 检查另有两个专用槽位；每个请求都有时间限制，失败的请求不会在每次轮询时重复。对于你未设置的 GitLab 主机，Trail 只跟踪有限的数量；超出的主机会显示为过多，且永远不会被访问。具体数字见 README。
- **文件。** 文件查看只读取任务文件夹和 agent 接触过的文件，最大 512 KB。Trail 的文件（个人配置、收集到的链接、每个会话的选择、保存的 token）都位于 `$PASEO_HOME/trail`；两项设置保存在 Paseo 自身的设置中，每条命令的提示保存在 agent 的时间线中。
- **其他读取。** 为了找到自己的文件夹，Trail 会读取 Paseo 的 `$PASEO_HOME/config.json` 以及其中列出的插件的 `paseo-plugin.json`，并在 agent 的工作目录中运行 `git rev-parse` 来读取分支名。

## 限制

GitHub 支持仅限 github.com。在安装 Trail 之前创建的 agent 没有 `pin_link` 工具；fork 出的会话开始时按钮栏为空，直到其 agent 固定任务为止。单独的 `!N` 或 `#N` 不会被识别为链接。
