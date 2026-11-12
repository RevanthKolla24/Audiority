# Native release validation

Automated regression and development Electron GUI smoke tests run on macOS and Windows before release packaging. They do not prove that a packaged installer, an installed upgrade, or every native desktop configuration works.

Release builds now inspect the actual `app.asar` for required UI/bridge assets, check the packaged version and license, and validate/execute the bundled native media tools. Both platform jobs must succeed before a single publication job uploads all assets to a draft and publishes it. This is resource/tool validation, not packaged-GUI automation; installed upgrades remain manual acceptance checks.

Profile editing is protected against Queue navigation and desktop import shortcuts. Windows desktop commands are ignored while a modal dialog is open. Busy controls refresh even outside Queue. The queue displays an Auto-Trash warning when enabled, and Windows exposes detailed policy information in an expandable summary.

The follow-up UI audit fixes delayed Settings/Statistics responses overriding newer navigation or an active profile draft. Regression tests cover out-of-order responses and obsolete errors while retaining current-request error reporting. Long unbroken output/watch paths and error messages now wrap instead of widening the workspace; the GUI smoke test reproduces this overflow and checks both platform layouts. The audit validation run passed 151 tests and both macOS and simulated Windows-layout GUI smoke tests. These results do not sign off any native acceptance check below.

Use disposable fixture media and a fresh test profile. Keep Auto-Trash off; automated smoke tests replace the OS Trash call with a stub. Never use the only copy of a movie.

## Windows presentation changes

The Windows-only workspace uses sidebar navigation, a compact import area, more readable Segoe UI typography, wrapping queue actions, a standard native window frame and a native File/Edit/View menu. Shortcuts: Ctrl+O adds files, Ctrl+Shift+O adds a folder, Ctrl+N creates a profile, Ctrl+, opens settings, Ctrl+1 opens the queue and Ctrl+2 opens statistics. Existing conversion and busy-state checks still apply.

`npm run prepare:icons` regenerates the Windows ICO with 16, 20, 24, 32, 40, 48, 64, 128 and 256px PNG representations. Windows distribution builds run this automatically. The NSIS include explicitly requests system DPI awareness and Segoe UI dialog typography. This avoids claiming unverified per-monitor DPI support; test installer movement between mixed-DPI displays separately.

`npm run test:ui:windows` exercises the Windows DOM/CSS presentation even on macOS. It is not an installer, native menu or physical 4K display test. Windows CI runs the normal smoke test with the actual Windows presentation.

## Required manual checks (not yet signed off)

## Conversion performance follow-up

Copied and compatibility-retained audio now share one streaming packet scan per file, with independent per-track hashes; ordinary copied audio is included rather than only compatibility originals. The existing structure probe is reused. Video and subtitle/font verification remain separate, so a complete conversion still performs multiple reads. No full-length movie speedup or native Windows throughput has been measured.

Inspection records a source identity and rejects changes during inspection, before conversion, and before publication. Encoded sample rates are checked against the plan. Space estimates use planned compressed bitrates and PCM rate/channel/sample-width properties while retaining conservative input-size and publication-copy allowances.

Settings offers opt-in Adaptive verification resource use. It samples aggregate CPU and free memory once per second, starts conservatively, requires sustained headroom to increase work, and reduces new-task concurrency under pressure. Scheduling changes occur at task boundaries; active tasks are not suspended. It is not user-idle detection, foreground-app identification, thermal monitoring, disk-load detection, or all-core encoding. Balanced retains existing bounded verification concurrency. Movie conversions remain serial, existing encoder-thread limits remain unchanged, and priority is not raised. Native Windows contention/drive benchmarks remain pending.

Validation for this follow-up: 155 tests passed, simulated Windows-layout GUI smoke passed, and macOS GUI smoke passed on retry after an initial timeout. GUI tests use disposable application data and media. Broader scan consolidation, full-length throughput measurements, and comprehensive audio-default/metadata validation remain follow-up work; no speedup percentage is claimed.

### Native acceptance checklist

Navigation follow-up (November 11, 2026): direct page transitions now invalidate pending Settings/Statistics requests, including responses arriving after profile entry/exit. Settings save responses preserve newer form edits and do not refill a different page or a newer settings snapshot; duplicate submissions are ignored while a save is pending. Four new navigation cases reproduced failures before the direct-transition fix. Validation: 170 tests passed, plus macOS and simulated Windows-layout GUI smoke tests. This does not establish native Windows acceptance. Completed-job diagnostics, representative throughput benchmarks and the native checklist below remain open.

Audio output mapping is now shared by command construction and structural validation. Validation checks intended default flags, language and title for every original/replaced/appended audio slot. Copy-only language filtering explicitly preserves non-default flags when the original default is removed instead of allowing muxer auto-selection. Unit fixtures reject altered defaults/metadata and reordered audio; real FFmpeg fixtures cover filtered copy-only outputs alongside the existing compatibility/language tests. This pass passed 162 tests and both macOS and simulated Windows-layout GUI smoke tests. These checks validate file metadata, not player selection or receiver passthrough. Full-length performance benchmarks, completed-job diagnostic enhancements and native visual acceptance remain open.

The verification cleanup replaces batch barriers with a refilling bounded task pool. Packet fingerprints now require full SHA-256 records and nonempty selected streams and compare packet counts as well as ordered hashes. Empty copied streams are rejected conservatively rather than accepted without payload evidence. Resource mode is grouped with Processing controls and marked experimental. A synthetic uneven-task scheduler comparison measured approximately 122 ms batched versus 102 ms refilling on this Mac; this is not movie or disk-throughput evidence. The consolidated probe still hashes all audio before selecting compared streams; that CPU tradeoff and full-length benchmarks remain open.

Record OS version, architecture, Audiority versions, display scaling and results for each run.

| Check | Windows x64 | macOS Apple Silicon |
| --- | --- | --- |
| Install packaged build; first launch, permissions/security prompts, tool execution | Pending | Pending |
| Older installed build to new installed build; queue/settings survive, restart works | Pending | Manual replacement pending |
| Installer refusal/cancellation/failure; app remains usable and update retry works | Pending | Not applicable: manual updates |
| Minimum window, resize/maximize, 100/125/150/200% scaling, multiple monitors | Pending | Pending |
| Light/dark/custom themes; long names, progress ranges, dialogs fit | Pending | Pending |
| Keyboard-only navigation, focus after modal close, Escape, screen reader labels | Pending | Pending |
| Long/Unicode paths, network shares, disconnected/reconnected storage | Pending | Pending |
| Locked output, denied permission, disk full, hard-link publication fallback | Pending | Pending |
| Queue restore, interrupted conversion recovery, failed Clear persistence | Pending | Pending |
| Original Windows failure movie; full-length ASS subtitles and embedded font rendering in target player | Pending | Pending |

For Windows upgrades, verify the published feed names the actual installer and that size/SHA-512/blockmap match. Test from an actual older installation, not just an unpacked development app. Release-asset validation does not repair an already published mismatched feed.

Full-length subtitle rendering must be checked in the intended playback software; byte-preservation tests alone do not validate renderer compatibility or appearance. Preserve logs and copies of failing fixtures, with consent, for diagnosis.