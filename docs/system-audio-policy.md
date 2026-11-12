# System-aware layout planning

Playback profiles now store installed `speakerLayout` separately from codec/path
capabilities. `unknown` is the default; no receiver model implies an installation.
`layoutPolicy` defaults to `legacy`, preserving existing explicit downmix behavior.

- **Existing explicit layout rules:** retains current behavior and stored rules.
- **Playback system:** disables Audiority layout downmix rules and prefers copying
  supported original streams. Receiver/player processing is user-selected, not
  detected. Unsupported codecs still need a safe supported output or remain unresolved.
  Choosing this mode is not proof that the complete path can decode/downmix.
- **Fixed-layout compatibility:** requires confirmed stereo, 3.1 or 5.1(side).
  Generates mappings from known larger layouts and prefers preserving suitable
  streams. Smaller sources are not upmixed. Unknown larger layouts or equal-count
  layouts with different positions remain unresolved rather than being relabeled.
  Front 6.1 to center-equipped targets remains unresolved. For 7.1 installations,
  use playback-system management: Audiority does not offer a 7.1 encoder target.

These policies operate only in playback-profile mode. Manual and DTS-core-only
modes retain explicit semantics. Exclusions and keep-original conversion rules
take precedence; explicit format requests remain subject to path/encoder checks.
Stored legacy downmix rules are not deleted when selecting a new mode.
Existing retention choices independently control replacement versus an additional
compatibility track. A verified matching DTS core can avoid a new lossy encode.

The setup preview and per-track reasons explain the selected policy; completed
conversion reports include policy plus actual filters. This is reference routing,
not receiver-branded acoustic optimization. Optional center/dynamics settings still
apply where eligible. Room EQ, crossover/bass management, distance delays and
speaker calibration are left to playback hardware. No automatic receiver detection,
headphone virtualization, 2.1/4.1/height layouts or acoustic measurements are added.

Validation covers migration, malformed settings, precedence, unsupported paths,
no-upmix decisions, position mismatches, matching-core extraction, UI draft/preview
round-tripping and real retained-original plus stereo output. Native Windows and
actual-system listening acceptance remain separate requirements.

## Stabilization checks

Fixed-target confirmation is enforced only in playback mode. Manual and
DTS-core-only modes may retain an inactive fixed policy with unknown/7.1 speakers;
switching back to playback requires a valid fixed target. Invalid enum values are
still rejected in every mode. Library tests exercise save/reload and profile
switching, including inactive policies. GUI smoke also saves a fixed stereo policy,
checks the persisted library, reloads the renderer and verifies the resolved rules.

Smoke diagnostics log elapsed time and the current renderer/screenshot operation.
One instrumented timeout stopped in the theme-icon animation-frame sequence.
The smoke window now disables background throttling only in the test harness;
production throttling is unchanged. Five consecutive macOS runs and one simulated
Windows-layout run subsequently passed. This supports a background/occlusion timing
explanation, but is not proof that all possible UI stalls are eliminated. Renderer
reload checks are not full Electron-process restart acceptance; library reload tests
cover the persisted schema independently.

## Full-process and hidden-window acceptance

Run `npm run test:restart` with local FFmpeg/FFprobe overrides when needed.
The Node coordinator creates private generated media and launches three separate
Electron processes against one disposable user-data directory:

1. Save a fixed-stereo profile, remember output folder, import media and quit via
   production queue-persistence shutdown handling.
2. Restore that profile and ready queue, convert while minimized then hidden with
   production background throttling enabled, detect completion from persisted queue
   state, restore the window and check the rendered report and theme icon.
3. Launch again, restore the completed reference, probe original/compatibility
   channel counts and check saved report rendering.

The coordinator removes only its private directory and applies process watchdogs.
The dialog overrides exist only in the acceptance harness. Native minimize events
and initial window presentation are awaited to avoid racing window animation.
This is synthetic acceptance on the host OS, not native Windows validation, abrupt
power-loss recovery, subjective listening or proof of every background UI behavior.

Fixed-layout copy exceptions now appear as track warnings. Excluded, explicitly
kept, smaller or unresolved originals may differ from the requested layout; keeping
original audio can also create multiple layouts in one file. Actual output/default
flags remain available in the verified report, not a guarantee of player selection.

Before conversion, queue cards show planned output order, retained originals versus
compatibility/replacement tracks, layouts, languages, titles and default flags.
This preview uses the command/verification audio mapping contract; it does not
change default selection. Blocked plans are marked blocked rather than presented
as runnable output. Completed files use the persisted verified report instead of
regenerating a preview from a potentially incomplete restored source plan.

## Compatibility-first controls and source cleanup

The queue's “Show detailed audio information” checkbox remembers its value in
renderer local storage for this user-data directory. Compact summaries still show
output layouts, original/converted roles and default intent. Blocking, language
removal and unresolved compatibility warnings stay visible in either view.

Retention controls explain output tracks versus source files. Explicit retain or
replace policies disable the inherited profile checkbox without erasing its value.
System-aware/DTS-core modes disable inactive explicit layout controls while keeping
stored rules. Server/player-managed downmixing is an explicit user choice, never
inferred from a Plex/Jellyfin name. Optional normalization and center gain remain
off by default; saved choices and global/profile precedence are preserved.

Enabling Auto-Trash now requires a main-process confirmation about possible loss
of higher-quality source audio; existing enabled preferences remain enabled.
Cleanup never moves external subtitle source files. It still verifies their copied
content before moving media. Blocked/unresolved/unconfirmed tracks, removed language
streams, or incomplete publication/recovery state retain the media source. This
version has no override for removed streams: review and remove those sources manually.
Verification checks retained packet content and selected metadata, not decoded-frame
identity, subtitle rendering, listening quality or player selection.