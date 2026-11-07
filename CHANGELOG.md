# Changelog

## 0.2.0 — 2026-11-06

**Upgrade notes.** If you installed Trail from Git or the registry, sessions created on 0.1.0 still
start the MCP server from 0.1.0's install folder, which every update deletes: after updating to 0.2.0
they lose Trail's tools. Start new sessions once 0.2.0 is installed; sessions created from 0.2.0 on
keep their tools through later updates.

- **Checklist on the Task button.** Agents keep a list of what the session's main task needs, in order,
  with status: to do, in progress, waiting, done or dropped. It sits above the Task button's menu; the
  button shows progress and turns amber when an item waits on someone.
- **Tasks given in chat.** `set_main_task` names the session's task when there is no doc or issue;
  `new_task` puts a finished list away when the session moves on.
- **Rules that keep the list a map.** An item needs a reason to be added, done needs evidence,
  waiting says on whom, dropped says why, and a status change clears the old note. At most 30 items.
- **Item details in a popover.** An item's reason and note open in a narrow popover that wraps long
  text, and agents are asked to keep notes to one short line.
- **A reminder to write the list.** Naming or pinning the main task while its checklist is empty tells
  the agent to add the items before it starts changing files.
- **How fresh an item is.** Items keep when they last changed. A waiting item's row shows what it
  waits on, an item waiting or in progress for hours shows its age, the popover says when it last
  changed, and the agent's own list marks long waits to check again. The tools ask for one item per
  step that finishes on its own, named as work rather than state, added as soon as it is known.
- **Reminder with every message (Claude Code).** `bin/trail-reminder.mjs`, set up as a
  `UserPromptSubmit` hook, gives the agent one line on where its checklist stands before each message.
- **Firmer reminders.** An empty list is reported as an order for the next tool call, and every task
  that changes files needs a list, even a one-step one; questions and read-only lookups do not.
- **Sessions survive a plugin update.** New agents start Trail's MCP server through
  `$PASEO_HOME/trail/bin/trail-mcp.mjs`, a launcher that looks up the current install in Paseo's
  plugin registry each time it starts, so an update that moves the plugin to a new folder no longer
  cuts them off. Agents created before this version still name the old path (see the upgrade notes).
- **Claude Code only.** Trail's MCP server and instruction are added to new Claude Code agents only;
  Codex agents no longer get them, since Trail is not tested there.
- **Docs and Other menus** name pages by host and path, cut in the middle.
- **Sessions older than an update** can run the same tools from their shell with `bin/trail-task.mjs`.
- **Main task from accumulated evidence.** The guess adds up edits, reads and mentions over the
  session; a close call shows `Task?` with the candidates to pin.
- **Files menu** names files by their path from the working directory.
- **`group/project#N` on GitLab is an issue.** A project this machine has seen on a GitLab host, or
  that the config's catalog names, is no longer linked as a GitHub pull request (which answered 404);
  its `#N` opens the GitLab issue from the Other menu, and its `!N` finds the host without a config.
- **`hashReferences: "gitlab"`** in the personal config reads `owner/repo#N` as a GitLab issue on your
  GitLab host unless the repository was opened on github.com or GitLab says it does not exist.
- A task named in chat is never read as a file path.

## 0.1.0

First release.
