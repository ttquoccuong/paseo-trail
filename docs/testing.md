# Testing a release

`yarn typecheck` and `yarn test` cover the rules. These scenarios cover what the tests cannot: what a
person sees in Paseo while working. Run each on a session created after the plugin was updated, on
desktop and on a phone connected through relay. Record results outside the repository: they name real
tasks.

Tests that measure time (`scan 2 MB of prose…`, `…poll budget of 50 ms`, `lists a big folder quickly…`)
fail on a heavily loaded machine; run them alone again before reading a failure as a regression.

| # | Way of working | What to do | Expected |
|---|---|---|---|
| 1 | Task given only in chat | Give a task in the first message, no doc or issue | The Task button shows the task with progress, `Task 0/N · name`, before the agent's first long step |
| 2 | Task from a doc | Name a task doc, edit it for a while | The button names the doc; reading other docs does not move it; `Task?` with candidates only when the guess is close |
| 3 | Task from an issue or ID | Pin an issue URL or a branch with a task ID | The checklist stays when the pin replaces a task named in chat |
| 4 | Detour | Ask for side work in the middle of the task | The `doing` item does not change; side work is not added |
| 5 | Waiting | Let the agent stop on a question to you | The item turns `waiting` with who or what; the button turns amber |
| 6 | Done | Let the agent finish an item | It is green and its note gives evidence |
| 7 | New task in the same session | Move the session on to different work | The old list is put away (`new_task`), the new list starts empty |
| 8 | Fork | Fork a session that has a checklist | The fork pins the task and re-adds the items with their statuses |
| 9 | Session older than the update | With a Git install, create an agent, update the plugin, then reload the agent | Its `trail` MCP server still connects and a Trail tool call works |
| 10 | Phone through relay | Open the Task menu on a phone | Same rows, icons and colours as on desktop |

A Git install moves to a new folder on every update and deletes the old one. Agents start Trail's MCP
server through `$PASEO_HOME/trail/bin/trail-mcp.mjs`, which looks the current install up in Paseo's
plugin registry, so scenario 9 holds for agents created on 0.2.0 or later. Agents created on 0.1.0
named the install folder itself and lose the server after an update; run scenario 9 on an agent
created on the version under test.
