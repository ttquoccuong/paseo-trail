# Trail

A long agent session scatters its work through the chat: the task it started from, the merge requests
it opened, the files it changed. To check whether CI passed you scroll back, find the link and open a
new tab.

Trail is a [Paseo](https://paseo.sh) plugin that keeps all of it in buttons above the chat box, with
live status for each request. It works with GitHub and with GitLab, self-hosted included.

![Trail: the task with its checklist, merge request, file and doc buttons above the chat, each opening a menu](assets/demo.gif)

## Install

```bash
paseo plugin add ttquoccuong/trail
```

This installs the version reviewed for [Paseo's plugin directory](https://paseo.sh/plugins/ttquoccuong/trail).
Trail needs Paseo 0.13 or later, with the daemon on macOS or Linux; Windows is not tested. Agents are
tested with Claude Code only. Links work without setup. Status and actions need a token, which
Settings, Plugins, Trail helps you add.

## What you get

- **Task.** The doc or issue the session works on, opened beside the chat or on your Git forge.
- **Checklist.** Above the Task button's menu: what the session's main task needs, in order, with what
  is done and what is left. It belongs to the session rather than a single turn, a task given only in
  chat can have one, and side work stays off it, so it still shows the way back after a detour. The
  button shows progress, and turns amber when an item is waiting on someone.
- **Merge and pull requests.** State, CI, conflicts, commits behind and approval, refreshed about once
  a minute. Rebase, Update branch and Merge are one confirmation away.
- **Files, docs and other links.** The most recent ones the session touched, including pages on tools
  such as Figma, Notion or Google Docs.
- **Self-hosted GitLab.** Point Trail at your host and project catalog, so that a reference like
  `api !42` resolves to the right merge request.

[OVERVIEW.md](OVERVIEW.md) has the full tour ([Tiếng Việt](OVERVIEW.vi.md), [简体中文](OVERVIEW.zh-CN.md)).

## What it reads and changes

Plugins run unsandboxed on the daemon machine, so here is what Trail touches:

- **Reads** the session's newest 300 messages, the task folder and files the agent touched (up to
  512 KB each), the branch name through `git rev-parse`, Paseo's `config.json` and the manifests of the
  plugins listed there. It can ask `glab` and `gh` for a token.
- **Keeps** its own files under `$PASEO_HOME/trail`: personal config, collected links, per-session
  choices and pasted tokens (mode 0600). Its two settings live in Paseo's settings, and each command
  leaves a note in the agent's timeline.
- **Adds** a `trail` MCP server with `pin_link`, `set_main_task`, `add_checklist_item` and
  `update_checklist_item` tools to new Claude Code agents, plus a short instruction that is sent to
  the model provider with the rest of the conversation.
- **Sends** a token only to the host it was set up for, and never along a redirect. A GitLab host named
  only by a link or a project file is not contacted until you set it up. `GITLAB_TOKEN` is the one
  exception: it goes to the host `GITLAB_HOST` names, or gitlab.com when that is unset.
- **Asks your GitLab** whether a project exists, only with `"hashReferences": "gitlab"` in the personal
  config and only for a repository named as `owner/repo#N` that Trail has not placed yet.
- **Changes your forge** only when you confirm Rebase, Update branch or Merge. Merge is refused if the
  branch or the merge settings changed since the status was read.

## Limits

GitHub support covers github.com only. Agents created before Trail was installed have no `pin_link`
tool, and agents created before an update lack the tools it added; they can run the same tools from
their shell with `node <current plugin folder>/bin/trail-task.mjs <tool> '<json>'` (`paseo plugin ls`
shows the folder). Sessions created on 0.1.0 lose Trail's tools after a Git or registry update; open a
new session. A forked session starts with an
empty bar until its agent pins the task. A bare `!N` or `#N` is not linked. Agents write the checklist;
you change it by telling the agent, and a menu that is open closes when the list changes.

## Configuration

For task docs or a self-hosted GitLab, add `.paseo/trail/config.json` to a project, or
`$PASEO_HOME/trail/config.json` for a personal setup. Settings, Plugins, Trail shows what it found and
takes tokens.

[docs/configuration.md](docs/configuration.md) lists every field, how references are matched, request
limits and the order tokens are looked up in.

### Checklist reminder with every message (Claude Code)

Paseo gives plugins no hook that runs per message, so keeping the list current relies on the agent.
Claude Code can help: a `UserPromptSubmit` hook runs `bin/trail-reminder.mjs` before each of your
messages, and the agent gets one line on where its checklist stands and a prompt to update it. It
says nothing outside a Paseo agent, in a session without a main task, or once every item is done. Add
it to a Claude Code settings file, user or project:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node <plugin folder>/bin/trail-reminder.mjs" }] }
    ]
  }
}
```

The line is sent to the model provider with your message.

## Develop

```bash
yarn install
yarn typecheck
yarn test
paseo plugin install "$PWD"      # then `paseo plugin reload trail` after each change
```

The plugin is plain TypeScript compiled by Paseo; there is no build step.
