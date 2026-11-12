# Security hardening status

## Validated local changes — November 11, 2026

- Electron is pinned to 44.11.1 with a matching lockfile. This is above the patched 44.x minimum (44.9.1) for GHSA-jr5w-w6x2-84p9. The locally executed binary reports 44.11.1.
- Updated the existing transitive Undici branches to 6.29.1 and 7.30.2 without a major-version override or forced audit fix.
- Local npm audit reports zero high/critical entries and seven moderate entries. Audit counts are affected dependency entries, not independently proven application exploits. Remaining findings involve the build-tool dependency tree and require reachability review; they are not waived.
- Captured subprocess stdout is limited to 32 MiB; streamed lines are limited to 1 MiB. Oversized results fail explicitly rather than returning truncated data. Streaming packet scans do not have a total-content limit. UTF-8 decoding preserves metadata across chunk boundaries. Termination escalates after one second; rejection normally waits for child close.
- Release Actions use immutable commit references. Build jobs have read-only repository permissions; only publication has write permission. Checkouts do not persist credentials.
- Validation: 178 tests passed, macOS GUI smoke passed, simulated Windows-layout GUI smoke passed. Output-limit and UTF-8 regression cases failed before the fix. No release or native Windows installation was performed.

## Release-security work still required

### Cleanup follow-up — November 11, 2026

Startup sweeping now requires an exact temporary path recorded in the current profile's recovered queue. Matching UUID filenames and known output directories alone no longer authorize deletion. A disposable regression reproduced deletion of two unrelated files before the fix; additional coverage checks isolation between queues sharing an output directory. Existing source/output protections and hard-linked output identity recovery remain tested. Validation: 180 tests passed and both macOS and simulated Windows-layout GUI smoke passed.

Unrecorded leftovers (including subtitle temporaries) are intentionally retained. This may leave disk space to reclaim manually; never recommend deleting files solely by their name. No claim of complete temporary-file ownership security is made.

The next follow-up persists a full temporary-file snapshot after FFmpeg finishes and before verification. Queue validation/storage preserves it; recovery requires device, inode, size, mtime and ctime to match before removal. Legacy paths without snapshots and replacements at recorded paths are retained. Publication with failed temporary cleanup also attempts to record the leftover snapshot without blocking recording of the published output if that attempt fails. The replacement regression failed before the fix; queue round-trip and real-conversion callback coverage were added. Validation: 182 tests passed and both GUI smoke layouts passed.

This is a completed-partial snapshot, not an exclusively reserved creation identity or private workspace. A crash during writing can leave an untracked partial; hostile queue modification, changes before snapshot capture, inode reuse, source aliases and check/unlink races are not fully addressed. Native Windows filesystem behavior remains unverified. Stronger workspace/creation ownership design remains open.

1. Resolve or explicitly assess remaining moderate advisories using dependency reachability and packaged contents. Do not blindly downgrade the builder as suggested by a forced audit fix.
2. Replace moving FFmpeg/FFprobe download URLs with reviewed version-specific artifacts and independently approved digests. Verify before extracting/executing. Current post-download hash recording is not provenance verification. Inspect the exact bundled tools and libraries against upstream advisories and redistribution requirements.
3. Establish release signing/publisher authentication and validate the packaged update configuration. Credentials require owner setup. Do not equate installer hashes with publisher authentication. Decide whether unsigned builds should offer manual updates only until authenticated installation is available.
4. Test tampered installer/feed assets, publisher mismatch, corrupted downloads, installer cancellation/failure, and rollback on actual Windows installations.
5. Evaluate local-media protocol restrictions for every FFmpeg/FFprobe input, including legitimate mounted-storage use. No protocol policy was changed in this pass.
6. Audit IPC payload bounds/main-frame identity, Electron fuses, renderer injection, malicious media, attachment/metadata counts, Windows junctions/reparse points, cleanup ownership and path replacement races. The tool limits do not sandbox native media parsers or guarantee a fixed CPU/memory ceiling.
7. Add repeatable security CI/advisory review and an artifact/tool manifest. Action pinning alone does not authenticate third-party media-tool downloads.

## Correctness and acceptance work still required

- Complete publication/recovery/Auto-Trash failure injection and independent expected-output audio fixtures.
- Add persisted source-to-output track diagnostics and stage timings with privacy controls.
- Benchmark Balanced/Adaptive with representative disposable media; do not claim throughput improvements from scheduler microbenchmarks.
- Finish screenshot-based acceptance and actual Windows installer/upgrades/DPI/mixed-monitor/storage testing.
- Investigate Garden of Words only after receiving original/output reports, the actual Windows profile/log, and exact-file playback comparisons.

Preserve uncommitted work and personal settings. Use disposable media; keep Auto-Trash off during manual investigations. This document is not a security certification.