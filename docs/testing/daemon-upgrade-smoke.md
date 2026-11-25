# Supported-agent upgrade smoke

This opt-in smoke uses the installed, authenticated Codex CLI in a disposable Craig workspace. It builds actual A/B npm packages through `pnpm build:npm`, applies a fixture-only Changeset to B, and changes a host source input to exercise a distinct revision. It leaves global Craig/Codex installations and other workspace daemons alone. Codex runs with `--no-daemon`, read-only sandboxing, and no tool requests; the fixture's agent receives its own Craig task context.

Run from the Craig checkout:

```sh
pnpm exec tsx scripts/fixtures/agent-upgrade-smoke.ts
```

The script prints its private fixture root, terminal snapshot file, operator command file, Codex version, and conversation nonce. Inspect `screen.txt` while driving the real terminal through `operator-command.json`. Give every command a unique `id`; wait for the resulting screen before replacing the command file.

```json
{"id":"trust-fixture","action":"key","text":"ENTER"}
```

Trust only the printed disposable fixture if Codex asks. Verify the actual assistant responds `FIRST_OK` to the initial nonce-bearing prompt. Type a harmless, sufficiently long task that uses no tools, then submit it with a separate Enter command:

```json
{"id":"busy-turn","action":"input","text":"Without using tools, produce 80 numbered one-sentence observations about reliable railway timetables. Finish with TURN_DONE. Keep the earlier conversation nonce for my next question without repeating it."}
```

```json
{"id":"submit-turn","action":"key","text":"ENTER"}
```

While the real agent reports working, request the update:

```json
{"id":"update-during-turn","action":"update"}
```

This records process/start/cwd/PTY facts, removes installation A, invokes B, and records the same facts after control replacement. Wait for the real response to finish. Ask for `RECOVERED` followed by the earlier nonce without supplying the nonce again. Submit with a separate Enter command and inspect the assistant's answer. Reattach and inspect earlier scrollback and the final output as well.

```json
{"id":"verify-and-finish","action":"finish"}
```

Finish fails unless control changed, the real process tree/start identities/cwd/TTY stayed identical, the update began while working, and an assistant line contains the recalled nonce. It writes private `verified-evidence.json`, closes the fixture agent and runtimes, and removes fixture packages/cache. An `abort` action preserves the fact that evidence is unverified and cleans only fixture-owned processes. Do not use runner resume, fork, transcript restoration, or relaunch to make this pass. Keep terminal contents and credentials out of lifecycle logs and the published npm artifact.

Automated regression coverage is in `tests/host-rollover.test.ts`, `tests/retained-host-adapter.test.ts`, `tests/artifact-retention.test.ts`, `tests/session-host.test.ts`, and the existing replacement/launcher suites. A passing stub test does not replace this actual-agent check. Record actual package/host/service/agent identities, all seven release gates, and any missing manual evidence in the RFC tracker. Owner review remains a separate human review step.
