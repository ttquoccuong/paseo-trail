Trail 在聊天输入框上方为 agent 会话正在处理的内容添加按钮：它的任务和任务所需事项的清单、带实时状态的 merge request 和 pull request，以及在需要时，会话接触过的文件和页面。每个按钮都会打开一个菜单，即使会话很长，相关链接也只需一次点击。

## 功能

- **任务。** 会话正在处理的文档或 issue。可以在聊天旁的只读标签页中打开它，也可以在 Git 托管平台上打开。当设置了 `bundle: "siblings"` 且任务文档名为 `<名称>/README.md` 时，同一文件夹中的其他 Markdown 文件（最多 20 个，包含一级子文件夹）会一并列出。
- **清单。** 位于 Task 按钮菜单的上方：会话主任务需要完成的事项，按顺序排列，每项处于待办、进行中、等待、完成或放弃之一。agent 为每项写明原因，完成时写明证据，等待时写明在等谁，这些内容可在弹出框中查看。按钮显示进度，例如 `Task 2/5`，有事项在等待他人时变为琥珀色。只在聊天中给出的任务也有清单；旁支工作不会加入清单，因此绕路之后清单仍能指明回到主线的路；会话转向其他工作时，已完成的清单会被收起。
- **Merge request 和 pull request。** 任务文档中以 URL 形式写出的 GitLab MR 和 GitHub PR（最多 20 个）、所有已固定的，以及会话最近提到的另外五个，显示状态、CI、冲突、落后的提交数和审批情况，大约每分钟刷新一次。Rebase、Update branch 和 Merge 只需确认一次，确认框会以项目和编号说明所操作的请求。
- **文件、文档和其他链接。** 在“全部链接”模式下，每类各保留最近的 15 项：agent 读取或编辑过的文件、Figma、Notion 或 Google Docs 等工具上的页面，以及对话中的其他链接。

可以在任务按钮的菜单中，或使用 `/trail-task` 和 `/trail-all`，在“仅任务链接”和“全部链接”之间切换。`/trail-copy` 会把这些链接复制为 Markdown 列表，`/trail-pin` 和 `/trail-unpin` 用于添加或移除单个链接。每条命令都会在对话中留下一条简短提示供你查看，这条提示不会发送给 agent。

## 工作方式

在 agent 运行期间，daemon 每 30 秒（最长三小时）读取一次会话最新的 300 条消息，并记录 agent 读取或编辑过的文件路径，每轮结束时再读取一次。Shell 输出会被忽略。如果 agent 没有固定或命名任务，Trail 会自行推测：你提到的文档权重最高（同一条消息提到多个文档时平分，会话第一条消息加倍），其次是 agent 编辑的文档，agent 只读取或提及的文档权重很低；随着会话转向其他工作，旧的依据会逐渐减弱。当另一个文档的分数接近时，按钮显示 `Task?`，可在菜单中选择正确的任务。新建的 Claude Code agent 会获得一个名为 `trail` 的 MCP server，其中有四个预先批准的工具：`pin_link` 用于指定任务和添加链接，`set_main_task`、`add_checklist_item` 和 `update_checklist_item` 用于维护清单。一条简短说明要求 agent 在你说出任务时立即固定它，在修改文件之前列出任务所需的事项，边做边报告进度，并以 URL 或 `project!N` / `owner/repo#N` 的形式书写 merge request 和 pull request。从 fork 会话摘要开始的 agent 会被要求自行固定原会话的任务和请求并重新添加其清单，因为 Trail 无法读取该摘要。这条说明、这些工具的描述以及每次调用的结果，都会随对话的其余内容一起发送给 agent 的模型提供商。

agent 通过 `$PASEO_HOME/trail/bin/trail-mcp.mjs` 启动该 server。这个启动脚本会在 Paseo 的插件注册表中查找当前安装，因此即使更新把插件移到新文件夹，会话也能保留工具。

Paseo 没有为插件提供随每条消息运行的 hook。如果你使用 Claude Code，可以在自己的 Claude Code 设置中把 `bin/trail-reminder.mjs` 添加为 `UserPromptSubmit` hook：在你发送每条消息之前，它会告诉 agent 一行清单进展。README 中有配置示例；这一行会随你的消息一起发送给模型提供商。

## 设置

Trail 需要 Paseo 0.13 或更高版本，daemon 运行在 macOS 或 Linux 上；未在 Windows 上测试。Agent 仅在 Claude Code 上测试。`glab` 和 `gh` 为可选。

链接功能无需设置。要识别任务文档和自托管 GitLab 上的项目，可以在项目中添加 `.paseo/trail/config.json`，或在 `$PASEO_HOME/trail/config.json` 保存一份个人配置。项目配置只能指向项目内部；token 的读取位置、哪些 GitLab 主机可以使用你的 `glab` 登录，以及任务 ID 的匹配规则，都只能写在个人配置中。[配置说明](https://github.com/ttquoccuong/paseo-trail/blob/main/docs/configuration.md) 列出了所有字段。违反这些规则的项目配置会被忽略，原因显示在设置中，并改用个人配置。

查看状态和执行操作需要 token：GitLab 查看状态需要 `read_api`，Rebase 和 Merge 需要 `api`；github.com 的 classic token 需要 `repo` 才能执行 Update branch 和 Merge。Trail 首先查找在 Settings、Plugins、Trail 中粘贴的 token，然后查找个人配置和 daemon 环境变量指定的位置，最后是 `glab` 或 `gh` 的登录信息；具体顺序见配置说明。设置页面会显示每个 token 的状态以及缺失时的解决方法，也可以设置默认模式和界面语言（英语或越南语）。

## 数据与权限

- **Token。** token 只会发送到为其配置的主机，并且不会跟随重定向。只由链接或项目配置提到的 GitLab 主机不会获得任何 token，也不会被访问，直到你为它粘贴 token 或将它加入个人配置；设置页面会标出这类主机，避免误粘贴 token。唯一的例外是 `GITLAB_TOKEN`：它会发送到 `GITLAB_HOST` 指定的主机，未设置时则为 gitlab.com。粘贴的 token 保存在运行 daemon 的机器上，只有运行 daemon 的用户可以读取。
- **操作。** Rebase、Update branch 和 Merge 都需要确认；如果分支或合并设置在读取状态之后有变动，Merge 会被拒绝。
- **请求。** 对所有托管平台的状态请求共用四个槽位，token 检查另有两个专用槽位；每个请求都有时间限制，失败的请求不会在每次轮询时重复。对于你未设置的 GitLab 主机，Trail 只跟踪有限的数量；超出的主机会显示为过多，且永远不会被访问。具体数字见配置说明。
- **文件。** 文件查看只读取任务文件夹和 agent 接触过的文件，最大 512 KB。Trail 的文件（个人配置、收集到的链接、每个会话的清单和选择、保存的 token，以及 `bin/` 中的 MCP 启动脚本）都位于 `$PASEO_HOME/trail`；两项设置保存在 Paseo 自身的设置中，每条命令的提示保存在 agent 的时间线中。
- **其他读取。** 为了找到自己的文件夹，Trail 会读取 Paseo 的 `$PASEO_HOME/config.json` 以及其中列出的插件的 `paseo-plugin.json`，并在 agent 的工作目录中运行 `git rev-parse` 来读取分支名。

## 限制

GitHub 支持仅限 github.com。在安装 Trail 之前创建的 agent 没有 Trail 的工具，在某次更新之前创建的 agent 缺少该版本新增的工具；它们可以在 shell 中运行 `node <当前插件文件夹>/bin/trail-task.mjs <tool> '<json>'` 来使用这些工具。在 0.1.0 上创建的会话在通过 Git 或注册表更新后会失去 Trail 的工具，请新建会话。fork 出的会话开始时按钮栏为空，直到其 agent 固定任务为止。单独的 `!N` 或 `#N` 不会被识别为链接。清单由 agent 编写；要修改，请告诉 agent。
