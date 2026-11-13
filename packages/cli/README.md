<div align="center">
<pre>
  ▄████▄   ██▀███   ▄▄▄       ██▓  ▄████
  ▒██▀ ▀█  ▓██ ▒ ██▒▒████▄    ▓██▒ ██▒ ▀█▒
  ▒▓█    ▄ ▓██ ░▄█ ▒▒██  ▀█▄  ▒██▒▒██░▄▄▄░
  ▒▓▓▄ ▄██▒▒██▀▀█▄  ░██▄▄▄▄██ ░██░░▓█  ██▓
  ▒ ▓███▀ ░░██▓ ▒██▒ ▓█   ▓██▒░██░░▒▓███▀▒
  ░ ░▒ ▒  ░░ ▒▓ ░▒▓░ ▒▒   ▓▒█░░▓   ░▒   ▒
    ░  ▒     ░▒ ░ ▒░  ▒   ▒▒ ░ ▒ ░  ░   ░
  ░          ░░   ░   ░   ▒    ▒ ░░ ░   ░
  ░ ░         ░           ░  ░ ░        ░

</pre>

**An agnostic orchestrator TUI, for the people.**

[![npm](https://img.shields.io/npm/v/craig-cli)](https://www.npmjs.com/package/craig-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://github.com/hallsamuel90/craig/blob/main/LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-brightgreen)](https://nodejs.org)

[Website](https://craig-cli.com) · [Documentation](https://craig-cli.com/docs/) · [CLI reference](https://craig-cli.com/docs/cli/)

</div>

<a href="https://craig-cli.com/#demo">
  <img src="https://craig-cli.com/craig-hero-poster.jpg" alt="Watch Craig's task-to-merge demo: agent work, pull request checks, and merge">
</a>

[▶ Watch the full task-to-merge demo (65 seconds)](https://craig-cli.com/#demo)

Craig gives every task its own Git branch, isolated worktree, and live PTY, then keeps the agents, changes, pull requests, and checks together in one keyboard-driven workspace.

Bring the agent CLIs you already use—Claude Code, Codex, or Cursor. Craig is not another coding agent; it is the heads-up display and controls around them.

The paneled terminal UI is enabled by default, including framed panes, integrated tabs, a compact workspace sidebar, and live summaries on the start and pause menus. No Panel polish preview toggle is required.

_It's like a game, except the PRs are real._

## Why Craig?

- **Run agents in parallel.** Each task works in an isolated Git worktree, so one agent does not overwrite another.
- **Keep the native agent experience.** Every runner opens in a real PTY instead of a lowest-common-denominator chat wrapper.
- **Stay in flow.** Launch agents, move between tasks, inspect changes, and watch PR checks without leaving the keyboard.
- **Work across repositories.** Treat one repo or a directory of repos as a workspace while preserving real repository boundaries.
- **Let agents operate the workspace.** The same task model backs the TUI and CLI, so agents and scripts can inspect context and perform Craig actions directly.
- **Leave and come back.** New workspaces keep agents, PTYs, and terminal history in independent session hosts, so closing the TUI or losing the control service preserves the running conversation. Runtime code and dependencies are pinned outside the launching installation. Use `craig daemon status --json` to inspect compatibility without starting or replacing anything. Existing legacy sessions retain their original owner; migration waits for an empty runtime. A newer stable release automatically replaces compatible control code on the next runtime invocation. The running agent process and its PTY stay in place. `craig daemon restart` explicitly selects the invoked build for control; older releases never downgrade a newer service. New sessions use the current session-host revision; existing sessions keep their original host until they are deliberately closed or no longer retained.

## Install

```bash
npm install -g craig-cli
```

Craig requires Node.js 22+ and `git`. Install and authenticate at least one supported runner: Claude Code, Codex, or Cursor. Pull request discovery and review status also require an authenticated `gh` CLI.

The Pi coding agent is available as an opt-in feature preview under Options &gt; Feature Previews.

The Agent file opening preview lets an attached agent run `craig file open <path>` to display any readable text file directly in the active Craig TUI.

The **Ghostty terminal (new sessions)** preview is available under **Options > Feature Previews**. It is off by default. Enabling it uses Ghostty for newly created terminal sessions; existing sessions keep their backend. Disabling it returns new sessions to xterm. If an older workspace daemon is still running, existing sessions remain attachable; creating Ghostty sessions requires restarting that daemon after closing its sessions.

The preview runs offline with an embedded terminal library. Emoji widths and very long hyperlinks can differ from xterm; this preview has not graduated to the default backend.

## Quick start

Run `craig` in a full-screen terminal, then work through the TUI:

1. Select **+ New Workspace** and choose a Git repository. You can also choose a parent directory to work across its direct-child repositories.
2. Press `n`, name the task, and use `Ctrl+R` to choose Claude Code, Codex, or Cursor. Press `Enter` to create it.
3. Craig creates an isolated branch and worktree, starts the runner there, and takes you directly into its live PTY. Tell the agent what you want it to do.
4. Press `Ctrl+]` to return to Craig's control mode. Move between panels with `Tab`, navigate with the arrow keys or `hjkl`, and press `Enter` on a task to reattach to its agent.
5. Press `n` again to start more tasks while the first agent keeps working. Each task remains isolated in its own worktree.
6. Use **Files** to inspect the worktree and **Review** to follow diffs, pull requests, checks, and review state. Ask the agent to commit, push, create the PR, or merge from its PTY; Craig keeps the status in sync.

See the [TUI reference](https://craig-cli.com/docs/tui/) for every panel and keyboard shortcut.

## Local by default

Craig stores workspace state, task records, worktrees, and runtime metadata under `.craig/` at the workspace root. Do not commit this directory; ignore `.craig/` when the workspace root is itself a Git repository. Craig does not require an account or hosted control plane. Your agent CLIs still use their own authentication and network services.

## Go deeper

- [TUI reference](https://craig-cli.com/docs/tui/) — layout, controls, and task navigation
- [Runners](https://craig-cli.com/docs/runners/) — Claude Code, Codex, and Cursor setup
- [CLI reference](https://craig-cli.com/docs/cli/) — commands for humans, scripts, and agents
- [Configuration](https://craig-cli.com/docs/config/) — runners, checks, GitHub polling, and previews
- [Agent orchestration](https://craig-cli.com/docs/orchestration/) — delegation, durable prompts, events, and Fury workflows

## Contributing

Craig is open source under the [MIT License](https://github.com/hallsamuel90/craig/blob/main/LICENSE), but it is not a community-maintained project. Bug reports and focused questions are welcome. Please read the [contribution guide](https://github.com/hallsamuel90/craig/blob/main/CONTRIBUTING.md) before proposing a change and report security issues through the [security policy](https://github.com/hallsamuel90/craig/blob/main/SECURITY.md).

## Development

The first development/test/build command prepares a pinned Ghostty artifact. Use `pnpm ghostty:prepare` explicitly to populate the verified build cache; `CRAIG_GHOSTTY_OFFLINE=1` makes preparation fail if that cache is missing. The generated module is bundled into the CLI, so installed users do not need the cache or a separate Wasm file. Standalone executable builds should run preparation before bundling the same entry point.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm build:npm
pnpm package:audit
pnpm package:smoke
```

The npm package is published as [`craig-cli`](https://www.npmjs.com/package/craig-cli) from `packages/cli`.

### Terminal verification

`pnpm verify:terminal` runs seeded replay/differential checks, allocation churn, disposal races and real launcher E2E coverage. `pnpm package:smoke` also exercises the installed artifact through real PTYs with both backends.

The standalone build prepares and embeds the same verified Wasm and license notices. Its CI runs the artifact soak; the gate can also be run directly:

```bash
pnpm verify:artifact --executable /absolute/path/to/craig --profile quick --report /tmp/terminal-report.json
pnpm verify:artifact --executable /absolute/path/to/craig --profile soak --report /tmp/terminal-soak.json
```

The driver uses only Node built-ins, a host Node executable for its deterministic PTY peer, and Git. It creates an unrelated temporary workspace and tests replies, fragmented Unicode, paste, keys, output floods, resizing, links/styles, reconnect/toggle preservation and actual child-process cleanup. It also verifies that ordinary `task new` starts its own daemon and agent in the task worktree. Native ELF/Mach-O artifacts are copied into the temporary workspace before execution to expose relative build-directory dependencies. It does not call a model or require agent credentials. Its Node fetch preload is not a network-isolation proof for a native binary: use an external network sandbox for that check. This is also not proof of running without a separately installed Node runtime; the fixture intentionally uses host Node.

The **Terminal compatibility** workflow adds Node 22/24 × Linux/macOS coverage and a Linux Docker run with `--network=none`. Manual dispatch supports the extended `soak` profile. Reports contain daemon round-trip and output-to-snapshot timings; they do not measure the outer terminal's physical rendering or promise universal latency bounds.

<!-- libghostty notices -->

## Bundled terminal library notices

The experimental Ghostty backend bundles libghostty-vt 1.0.0 as WebAssembly. These notices cover Ghostty and its dependency manifest, including build-time components conservatively retained here. Dual-licensed components use the license option identified below.

### libghostty-vt 1.0.0 (MIT)

```text
MIT License

Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Highway 1.2.0 (BSD-3-Clause option)

```text
Copyright (c) The Highway Project Authors. All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

1.  Redistributions of source code must retain the above copyright notice, this
    list of conditions and the following disclaimer.

2.  Redistributions in binary form must reproduce the above copyright notice,
    this list of conditions and the following disclaimer in the documentation
    and/or other materials provided with the distribution.

3.  Neither the name of the copyright holder nor the names of its
    contributors may be used to endorse or promote products derived from
    this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### simdutf 9.0.0 (MIT option)

```text
Copyright 2021 The simdutf authors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### translate_c 2.0.0 (MIT)

```text
The MIT License (Expat)

Copyright (c) Zig contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### uucode 0.2.0 (MIT)

```text
# uucode license

MIT License

Copyright (c) 2026 Jacob Sandlund

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Other licenses

See [./licenses](./licenses) for licenses of code being used in the repo:

* [LICENSE_Bjoern_Hoehrmann](./licenses/LICENSE_Bjoern_Hoehrmann)
* [LICENSE_unicode](./licenses/LICENSE_unicode)
```

### Wuffs 0.4.0-alpha.10 (MIT option)

```text
Copyright 2023 The Wuffs Authors

Permission is hereby granted, free of charge, to any
person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the
Software without restriction, including without
limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice
shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

### aro build tooling (MIT)

```text
MIT License

Copyright (c) 2021 Veikka Tuominen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Unicode data (Unicode License V3)

```text
https://www.unicode.org/license.txt

UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2025 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```

### UTF-8 decoder by Bjoern Hoehrmann

```text
From https://bjoern.hoehrmann.de/utf-8/decoder/dfa/

Copyright (c) 2008-2009 Bjoern Hoehrmann <bjoern@hoehrmann.de>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### Zig runtime and standard library

```text
The MIT License (Expat)

Copyright (c) Zig contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
Task creation is admitted durably before provisioning on the split runtime. Supply `--operation-id <id>` to `craig task new` or `craig task create-child` to retry an uncertain result with the same identity. An interrupted, ambiguous provisioning operation reports `recovery_required` and preserves existing work for inspection.

Control replacement drains admitted work for up to five seconds, then reconnects existing clients to fresh terminal snapshots. Input is visibly paused during reconnection and uncertain prompt writes are never replayed. A drain timeout keeps the previous service running; failed startup restores the compatible pinned service when it can do so safely. An unresponsive living owner remains untouched. Equal-release development builds require explicit `craig daemon restart`. For a pre-RFC legacy runtime, finish all sessions and background work and close every old client before acknowledging the one-time transition with `craig daemon restart --migrate-legacy`; active or unverifiable owners block migration.

Craig updates leave existing agent processes, PTY handles, conversation state, and terminal scrollback in place. Retained exited views also survive control replacement. Closing a task or tab intentionally ends its session; host-process loss, OS reboot, and machine shutdown end live-process continuity. Craig reports lost ownership and preserves ambiguous state for inspection.

Runtime artifacts live in a private cache with their complete production dependencies. Cleanup checks references across known workspaces under the same lock used for publication and launch. Live processes, logical views, pending creates, handoff holds, rollback artifacts, and uncertain ownership keep the required artifacts. A durable cache ledger records each launched owner independently of workspace discovery. Missing host records or lost/recreated workspace registries retain their artifacts; caches predating this ledger remain conservative. Older hosts without atomic retirement support remain retained.
