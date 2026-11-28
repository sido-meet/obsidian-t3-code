# Changelog

All notable changes to **T3-Codian** (`t3-codian`) are documented in this file.

## [0.1.0] - 2026-11-28 (`feat/sidebar-v2-redesign` Release Candidate)

### Architecture & Backend (`RPC First + CLI Fallback`)
- Adopted [ADR-0003](docs/adr/0003-rpc-first-cli-fallback.md): implemented a zero-`effect` Effect-RPC JSON WebSocket + HTTP v2 primary client (`RpcBackend`) paired with `T3BackendManager` and automatic fallback to `CliBackend` (`t3 thread list/start/send/show`) when no compatible local T3 Server v2 is reachable.
- Added local loopback server discovery (`src/t3/discovery.ts`) validating `server-runtime.json`, `/.well-known/t3/environment` (`orchestrationProtocolVersion === 2`), `t3` CLI binary discovery, and strict 14-line Windows `t3.cmd` launcher verification.
- Implemented in-memory short-lived scoped session management (`T3AuthManager`, `src/t3/auth.ts`) via `t3 auth session issue/revoke` and `/oauth/token` one-time pairing codes without persisting credentials to disk, `data.json`, or logs.
- Fixed real T3 Server v2 incremental text streaming by reducing `turn-item.updated` (`type: 'assistant_message'`) events and mid-turn `turnItems` snapshots into `ThreadDetail.messages`, with completion finalization guards against stale/compacted overrides and terminal `run.updated` cleanup (`src/t3/protocol-v2.ts`).
- Enforced deterministic `commandId` / `messageId` dispatch tracking, pre-dispatch stream synchronization (`onThreadReady` + `synchronized`), `afterSequence` reconnect recovery with HTTP bounded fallback, and `UncertainWriteError` replay checks that never replay unconfirmed RPC writes via CLI.
- Hardened `CliBackend` with workspace path fallback when `projectId` is empty, active `openThread` poller wake-up on multi-turn `sendMessage` with bounded grace polling, centralized poller cancellation on `disconnect()`, and workspace project-binding validation.

### UI & Rendering (Obsidian Native V2 Sidebar)
- Migrated Markdown rendering from bundled `markdown-it` + `highlight.js` to Obsidian native `MarkdownRenderer.render()` (`src/ui/markdown.ts`), reducing candidate `main.js` bundle size from `192,306` bytes to `150,112` bytes (`< 204,800` bytes).
- Connected zero-header V2 sidebar (`src/ui/ObsidianT3CodeView.ts`, `styles.css`) to `T3BackendManager` and `T3Store`:
  - Live multi-Agent (`codex`, `claudeAgent`, `antigravity`, etc.), large model search/filtering with caret/focus preservation, dynamic reasoning effort & boolean extra options, and mid-thread model/mode/permission switching.
  - Live 240° SVG context window gauge and token breakdown (`input`, `cachedInput`, `output`, `reasoning`), plus honest five-state quota display (`available`, `unsupported`, `unknown`, etc.).
  - Real-time streaming Stop button, compact tool-call pills, inline runtime approval cards (respecting `responseCapability.supportsFeedback`), scroll-position preservation when reading history, and scoped Obsidian CSS overrides across dark/light themes and narrow (`< 300px`), single, and wide (`>= 600px`) dual-pane layouts.

### Security & Deployment Tooling
- Strengthened three-layer security boundaries:
  1. `VaultSafetyGuard` (`realpath` ancestor walk + Windows NTFS Junction/symlink overlap checks), fail-closed `VaultSecurityError` when `projectId` resolves to the Vault on mismatched `projectPath`, cross-client runtime escalation prevention, and CLI workspace binding checks.
  2. Unprivileged AI Markdown pre-sanitization (blocking `dataviewjs`/`templater`/executable fences including nested blockquotes/lists, `![[...]]` embeds, external tracking images, unsafe HTML tags, and non-`http(s)/mailto` links) + post-render DOM hardening + lazy plain-text fallback above 40,000 chars.
  3. Complete token/ticket/pairing-code redaction (`redactSensitiveText`) and strict in-memory credential handling.
- Added [scripts/deploy-obsidian.ps1](scripts/deploy-obsidian.ps1) and [scripts/rollback-obsidian.ps1](scripts/rollback-obsidian.ps1) supporting pre-deploy integrity backups, untouched `data.json` preservation, preflight + post-copy SHA-256 verification, automatic failure rollback, `-DryRun`, and Windows PowerShell 5.1 + PowerShell 7 compatibility.
