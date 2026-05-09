# Vendored from gotee_starter

This directory is a verbatim copy of [`spacecomputer-io/gotee_starter`](https://github.com/spacecomputer-io/gotee_starter) on the `pedro/qemu` branch. We vendor instead of submodule so this repo builds offline and modifications to `src/main.rs` (the Argus consensus engine) live in the same git history.

**Original CLAUDE.md (in this directory) is the authoritative agent context for the GoTEE plumbing.** Read it before touching `docker/trusted_os/` — there are several emulation quirks that bite obvious "simplifications".

What we change:
- `src/main.rs` — replaced with the Argus consensus engine.
- `docker/Cargo.toml` — additional deps as needed for the engine.

What we don't touch (per upstream's contract):
- `docker/trusted_os/*` — Trusted OS Go code.
- `docker/gotee_syscall/*` — applet-side syscall wrappers.
- `docker/Makefile`, `Makefile`, `scripts/`, `docker/qemu/`, `docker/applet.ld`.

Refresh procedure if upstream moves:
```
git -C /tmp clone --depth 1 -b pedro/qemu https://github.com/spacecomputer-io/gotee_starter
rsync -a --exclude='.git' --exclude='src/main.rs' /tmp/gotee_starter/ platform/tee/
# review diff in docker/Cargo.toml — re-apply our deps
```
