# Security boundaries

Rift is a trusted shared workspace. A shared token grants access to every workspace; there are no per-user roles or per-workspace permissions. Hidden text is display masking, not encryption. Content is not end-to-end encrypted. Do not present it as a hardened public multi-tenant service.

Use a long random token, HTTPS for remote access, a loopback backend, a trusted proxy/private network and a dedicated service account. An empty `RIFT_TOKEN` disables authentication. Do not expose that mode remotely. Configure allowed page origins when the trusted proxy rewrites Host, keep dependencies updated and verify your backups.

Originals, receipts, state and authentication configuration are private runtime data. Keep them outside version control. Treat backups, crash dumps, screenshots and diagnostic logs as sensitive. Do not include real attachments or credentials in bug reports. Use the generated fixtures to reproduce failures.

The renderer uses context isolation, no Node integration and sandboxing; the download bridge checks the requesting origin. Optional compatibility flags should be selected deliberately. Do not disable TLS verification or sandboxing in normal clients because a diagnostic fixture does so in isolation.

Before publishing source changes, review the exact staged files, commit metadata and history, scan for secrets and infrastructure identifiers, and verify configuration defaults. Never mirror an unrelated repository's Git history or copy a working directory wholesale. This source repository excludes runtime data, local environment files and workflow output; ignore rules alone are not a privacy review.

Do not post a security report containing secrets or private content in public issues. Use GitHub's private reporting channel if enabled. Otherwise prepare a reproduction with synthetic data and no exploitable credentials before opening an issue.
