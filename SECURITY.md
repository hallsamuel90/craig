# Security

Craig is a local developer tool. It creates local worktrees, starts local PTY sessions, reads local Git state, and can call local tools such as `git`, `gh`, Codex, Cursor, or Claude.

Report security issues privately to hallsamuel90@gmail.com instead of opening a public issue. Include enough detail to reproduce the problem, but do not include live credentials, private repository content, or sensitive `.craig/` artifacts.

Treat `.craig/` as private local state. It can contain task prompts, terminal logs, local paths, branch names, PR metadata, runtime state, and worktrees.

Public issues are appropriate for normal bugs and installation problems, but not for vulnerabilities or accidental disclosure of private data.
