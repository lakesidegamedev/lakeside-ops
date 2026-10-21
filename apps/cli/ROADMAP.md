# Road to Lakeside Code 1.0

Baseline: 0.1.4-preview.5, preview channel only. This is a working plan, not a
promise about dates. Each item is done when the evidence named with it exists.

## What 1.0 means

1. Products installs from a stable channel, verifies the artifact and can roll back.
2. Every platform we claim works has recorded acceptance evidence: native Windows 11,
   Windows + WSL2, and Linux. macOS only if it is supported on purpose.
3. The unit and contract suites run on each supported OS in CI, not just Linux.
4. Every command has help, a documented exit code, and a typo never starts a session.
5. Credentials stay file references: HTTPS or loopback only, never echoed, rotation
   documented, and the default token location is not the user's Downloads folder.
6. Connection failures are reported by cause (auth, timeout, unreachable), read-only
   probes may retry once, and writes are never retried automatically.
7. Install, upgrade, recovery and known limits are documented without the word
   "experimental" on core paths.

## Baseline evidence (2026-10-21, Windows 11, Node 22.20.0)

- `npm --prefix apps/cli run typecheck:contracts` passes.
- `node --test apps/cli/*.test.* apps/cli/headless/*.test.js` -> 63 pass, 7 fail.
  Every failure is a POSIX assumption, not a product defect:
  - `0o600` mode assertion (Windows chmod is a no-op) — commands.test.js:19
  - stub executables written with a shebang and spawned directly — commands.test.js:32, launch.test.js
  - `EBUSY` on temp-directory cleanup — native.test.mjs
  - tests reading the real home config instead of a fixture — peers.test.mjs:18
- The Windows CI job runs only the smoke scripts and a ConPTY check; the test suite
  that fails above never runs there.
- First-run friction observed while connecting a real VPS: `vps --help` exited 1 with
  "--help needs a value", an unknown `vps` subcommand printed a connect-only usage
  line, and top-level help omitted `vps status`. Fixed in this change.
- All 7 failures above are now fixed on Windows in the working tree: portable engine
  stubs via `test-support/engine-stub.cjs`, an isolated peer fixture, a cross-spawn
  launch (so `.cmd` shims work), and native `close()` awaiting the backend child.
  Local result: `npm run test:cli` 81 pass, 0 fail, 2 skipped (83 tests), and the installed-terminal ConPTY smoke test passes on Windows 11. The Windows CI step is
  added but not yet observed on a runner.

## Phase 1 — CLI contract

- [x] `vps --help` and accurate `vps` usage for unknown subcommands
- [x] top-level help lists `vps status`
- [ ] help for `peers`, `handoffs`, `skills`, `update`, `runs`, `projects`, `mcp`,
      `workflow`, `backends`
- [ ] an unknown top-level word is a usage error instead of falling through to
      `launch()` with the typo as a project name
- [ ] exit codes documented: 0 success, 1 usage or failed check
- [ ] `doctor` reports VPS reachability and token-file age

Evidence: each item covered by `commands.test.js`, plus a manual run of every
command's `--help`.

## Phase 2 — Windows and WSL parity

- [ ] `windows-latest` runs the CLI unit suite and passes; fix the 7 failures above
      without weakening the assertions (for example, replace mode-bit checks with a
      Windows-appropriate ACL or a documented platform skip)
- [ ] WSL2 acceptance job: install, configure a VPS, run a session
- [ ] record the matrix result in the README

Evidence: green `code.yml` on `windows-latest`, plus a WSL job log attached to the
release.

## Phase 3 — Connection reliability

- [x] retry read-only discovery once on `connection` errors; never retry `auth`
- [x] `lakeside code doctor` reports the VPS from the same probe as `vps status`,
      bounded at 3s and never fatal
- [ ] separate `timeout` from `unreachable` and name the failing step
- [ ] the in-session `/doctor` panel shows the same VPS verdict as the CLI
- [ ] token rotation walkthrough, including what to do when a token page requires auth

Evidence: `vps-discovery.test.mjs` cases for each state, and one real reconnect run
after the token was rotated.

## Phase 4 — Distribution

- [ ] promote 0.1.4 to the stable channel once phases 1-2 are green
- [ ] checksums and signing for the Windows installer
- [ ] rehearse upgrade and rollback from a stable install
- [ ] default token path under the config directory; `vps connect` warns when the
      credential file sits in Downloads or another shared folder

Evidence: `update.test.js`, a clean-machine install per OS, and a rollback log.

## Phase 5 — Engine and providers

- [ ] documented upgrade path off the pinned OpenCode 1.19.0, with contract tests
      before the pin moves
- [ ] provider matrix verified for subscription, API and native routes
- [ ] native backends: vendor acceptance, or keep them opt-in and say so

Evidence: contract typecheck plus a session per provider route.

## Phase 6 — 1.0 release

- [ ] support matrix and known limits published
- [ ] CHANGELOG moves 0.1.4 out of preview and drops experimental labels
- [ ] release checklist run on a clean machine for each supported OS
