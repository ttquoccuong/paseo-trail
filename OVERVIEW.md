Trail adds buttons above the chat box for what an agent session is working on: its task, its merge and pull requests with live status, and, when you want them, the files and pages the session touched. Each button opens a menu, so a long session's links stay one click away.

## What you get

- **Task.** The doc or issue the session works on. Open it in a read-only tab beside the chat or on your Git forge. With `bundle: "siblings"` and a task doc named `<name>/README.md`, the other Markdown files in its folder (up to 20, one level of subfolders) are listed with it.
- **Merge and pull requests.** The GitLab MRs and GitHub PRs its task doc links by URL (up to 20), every one pinned, and the five others the session mentioned most recently, with state, CI, conflicts, commits behind and approval, refreshed about once a minute. Rebase, Update branch and Merge are one confirmation away, and the confirmation names the request by its project and number.
- **Files, docs and other links.** In all-links mode, the most recent 15 of each: files the agent read or edited, pages on tools such as Figma, Notion or Google Docs, and other links from the conversation.

Switch between the task's links and all links from the task menu, or with `/trail-task` and `/trail-all`. `/trail-copy` copies the links as a Markdown list, and `/trail-pin` and `/trail-unpin` add or remove one. Each command leaves a short note in the conversation for you; the note is not sent to the agent.

## How it works

The daemon reads the session's newest 300 messages and notes the paths of files the agent read or edited, every 30 seconds during a turn (for up to three hours) and again when it ends. Shell output is ignored. A doc becomes the task when you name it or the agent edits it. New Claude and Codex agents get a `trail` MCP server with a preapproved `pin_link` tool and a short instruction to write merge and pull requests as URLs or `project!N` / `owner/repo#N`. The instruction also asks an agent that starts from a forked session's summary to pin that session's task and requests, since the summary is not visible to Trail. The instruction, the tool's description and the results of its calls are sent to the agent's model provider with the rest of the conversation.

## Setup

Trail needs Paseo 0.13 or later, with the daemon on macOS or Linux; Windows is not tested. `glab` and `gh` are optional.

Links work without setup. To recognise task docs and self-hosted GitLab projects, add `.paseo/trail/config.json` to the project, or keep one at `$PASEO_HOME/trail/config.json` for yourself. A project file can only point inside the project; where tokens are read from, which GitLab hosts may use your `glab` login, and a task ID pattern belong in the personal file. The [configuration guide](https://github.com/ttquoccuong/paseo-trail/blob/main/docs/configuration.md) lists every field. A project file that breaks these rules is ignored, with the reason shown in Settings, and the personal file applies instead.

Status and actions need a token: GitLab `read_api` for status and `api` for Rebase and Merge, and a classic github.com token with `repo` for Update branch and Merge. Trail looks for one pasted in Settings, Plugins, Trail first, then in the places your personal config and the daemon's environment name, then in your `glab` or `gh` login; the configuration guide gives the exact order. The settings screen shows each token's state and how to fix a missing one, and sets the default mode and the interface language (English or Vietnamese).

## Data and permissions

- **Tokens.** A token is only sent to the host it was set up for, and never along a redirect. A GitLab host named only by a link or a project file gets no token, and is not contacted, until you paste one for it or list it in your personal config; Settings marks such a host so a token is not pasted for it by mistake. The one exception is `GITLAB_TOKEN`, which goes to the host `GITLAB_HOST` names, or gitlab.com when it is unset. Pasted tokens stay on the daemon machine, readable only by its user.
- **Actions.** Rebase, Update branch and Merge ask for confirmation, and Merge is refused if the branch or the merge settings changed since the status was read.
- **Requests.** Status requests to all forges share four slots, token checks have two more of their own, each request has a time limit, and a request that fails is not repeated on every poll. Trail keeps track of a limited number of GitLab hosts you have not set up; past that, a host is shown as one too many and never contacted. The configuration guide has the numbers.
- **Files.** The file view reads only the task folder and files the agent touched, up to 512 KB. Trail keeps its own files (personal config, collected links, per-session choices, saved tokens) in `$PASEO_HOME/trail`; its two settings live in Paseo's own settings, and each command's note stays in the agent's timeline.
- **Other reads.** To find its own folder Trail reads Paseo's `$PASEO_HOME/config.json` and the `paseo-plugin.json` of the plugins listed there, and it runs `git rev-parse` in the agent's working directory to read the branch name.

## Limits

GitHub support covers github.com only. Agents created before Trail was installed have no `pin_link` tool, and a forked session starts with an empty bar until its agent pins the task. A bare `!N` or `#N` is not linked.
