# Audiority

A local Electron desktop app for macOS and Windows. Import videos, review the automatically generated per-track plan, choose a folder, and convert. Video is copied without encoding; the app writes a new MKV and never replaces the input.

## Receiver and playback setup

On first launch, complete the two-page setup:

1. **Receiver:** type a brand/model into the alphabetical searchable dropdown (keyboard arrows/Enter supported). The offline directory contains 126 receiver/home-theater models across Bose, Denon, Marantz, Onkyo, Pioneer, Sony and Yamaha. Entries distinguish documented presets, user-reported presets, and directory-only models. A listed name does **not** mean verified compatibility.
2. **Playback path:** choose Plex, Jellyfin, local or other; pick the device; describe your app, HDMI/ARC/eARC/optical/coaxial connection, optional TV model and passthrough setting. Unknown paths default conservatively to PCM stereo. To enable unverified formats, explicitly confirm the complete app/device/TV path.

Nine documented receiver presets currently cover Denon AVR-X1800H/X2800H/X3800H/X4800H/A10H, Marantz CINEMA 50/60/70s, and Bose Lifestyle 50. Their manufacturer references are stored with the catalog entries. Bose Lifestyle V20 uses the project owner's reported DTS/AC-3/PCM stereo compatibility, with conservative 16-bit/48 kHz PCM ceilings; its full input-limit matrix is not verified. The remaining 116 directory entries require Advanced capability confirmation. Sony STR-DH790 is deliberately directory-only because the retrieved manufacturer troubleshooting page is not a complete capability table.

Thirteen playback-device choices include Apple TV 4K, NVIDIA SHIELD TV/Pro, and clearly unverified generic/model-dependent entries. A documented output specification is only an upper bound, not a certified client/file compatibility profile. Device, firmware and player settings must be checked on the user's actual system. TV model and app/version text are descriptive; no automatic TV/app capability lookup or server/device discovery is performed.

**Advanced** can replace receiver selection, choose allowed DTS/AC-3/PCM targets, control source preservation, set preferences and valid bitrate/PCM ceilings, and add per-source/channel-scope rules. Explicit target rules do not silently fall back. Stereo-specific rules win over all-channel rules. Custom capabilities are user-confirmed rather than manufacturer verified. Preferences fall back to another allowed encoder only when exact layout preservation is possible.

The chosen receiver, player/connection restrictions, confirmed path formats and actual encoder capabilities all constrain conversion. DTS-HD and DTS core are distinct; an AC-3-only receiver no longer automatically preserves E-AC-3. PCM precision/rate reductions are displayed explicitly. ARC/S/PDIF conservatively excludes HD formats; unconfirmed TV passthrough is not assumed to work. Multichannel PCM is still not a conversion target.

### Multiple named profiles

Create as many named profiles as you need: there is no artificial profile-count limit (available memory/storage still applies). The sidebar supports search, selection, and **New profile**. Each profile independently stores receiver, playback path, custom rules, and codec limits. **Edit**, **Rename**, **Duplicate**, and **Delete** manage the active profile. Names are limited to 100 characters; duplicate names are allowed and profiles are identified by unique IDs.

Settings are saved locally in Electron's user-data directory as `playback-profiles.json`, using validated main-process IPC and atomic file replacement. The previous valid library is retained as `playback-profiles.json.backup`. An existing single `playback-profile.json` is automatically migrated to a profile named **My playback setup**, with the legacy file left intact. Corrupt libraries are not overwritten; restore the backup or move the damaged file aside before saving.

Subsequent launches restore the active profile. Switching profiles or editing active conversion settings recalculates queued plans and resets previous output results without deleting generated files. Renaming alone does not reset results. Profile operations are rejected during imports/conversions. Deleting the active profile selects the first remaining profile; deleting the last returns to setup. Canceling an edit/new profile discards the draft. Conversion uses one active profile for the entire queue; there is no automatic multi-profile batch export or per-file profile selection.

### Desktop workflow

The interface uses a persistent searchable profile sidebar, compact active-profile actions, an expandable compatibility-notes section, and collapsed per-file track plans. Open **How it works** for an in-app description and limitations. The UI requires a minimum 960×680 desktop window.

### Themes

Open **Settings → Appearance** for grouped palette previews of 12 presets: Warm Light, Graphite Dark, Midnight, High Contrast, Paper, Sandstone, Ocean Light, Rose Light, OLED Black, Forest Dark, Slate and Plum Dark. The header's Appearance shortcut opens the custom editor. Create a custom theme from the current palette, preview its colors, name it, and save it. Custom themes can be edited or deleted, and themes can be exported/imported as JSON. Selection and custom palettes persist locally in `appearance.json`, independently of playback profiles. Deleting the active custom theme restores Warm Light.

### Application settings and statistics

Use **Queue / Statistics / Settings** navigation. App-wide preferences are saved in `app-settings.json`, with validation, atomic replacement and a previous-valid-file backup. Receiver, exclusion and downmix rules remain per profile.

Settings include compact queue, reduced motion, remembering the output destination (on by default), preserving imported season structure, output suffix, encoder threads (automatic or a limit), 1–4 concurrent inspections (default 2), idle sleep prevention during conversion, and local statistics privacy. Changes save only while import/conversion is idle. Thread settings are hints to supported encoders, not a strict CPU cap; DTS encoding in this build has no threading support. Display sleep is permitted. Diagnostics exports include application/tool versions and encoder capabilities, not media filenames, paths or credentials.

Statistics are stored locally in `statistics.json`. Completed means a newly generated output passed verification. **Source data processed** counts the full size of successful source files, not the amount of audio re-encoded. **Output written** counts the resulting MKV bytes, excluding subtitle sidecars. GB is decimal (1,000,000,000 bytes). Source/output sizes are not a claim about compression efficiency or audio quality. Failed/cancelled attempts contribute processing time and attempt counts, but not successful bytes or track counts. Retrying failed work only adds successful bytes on completion; deliberately producing another output counts as another operation. Already-compatible/skipped files and import failures are not conversion attempts.

Counters include encoded/copied audio tracks, DTS-core extraction, downmixing, processing time, media duration, codec pairs, profile breakdown and UTC daily activity. Lifetime totals persist; daily breakdown is bounded to 366 days (the page shows the latest 30), recent history to 200 attempts, and profile breakdown to 1,000 names with an overflow bucket. History begins with this feature, not earlier conversions. Profile names are recorded; media filenames are opt-in, full paths never are. Disabling filename storage purges recorded filenames and the previous statistics backup. Disabling recording pauses new events without deleting history. Export and explicitly confirmed reset are available; exported files are the user's responsibility. Damaged files are not silently overwritten. A statistics save failure is surfaced without marking a verified media conversion as failed. History is not crash-resumable: a crash between output completion and statistics persistence can leave a completed output uncounted.

### Efficiency changes and benchmark

Progress messages are throttled, active cards are patched instead of rebuilding the queue, profile navigation is cached until its inputs change, and hidden application pages avoid queue rendering. Inspection runs in a bounded ordered pipeline. Sidecar association is indexed once per imported directory. External subtitle files and FFprobe verification output are hashed incrementally, retaining preservation checks without accumulating complete packet JSON in memory. Queue state still uses memory; these are not unlimited-library or encoding-speed guarantees.

Run `npm run benchmark` for a synthetic Electron benchmark. On the development machine, 200 progress updates with 5,000 queued files / 50 visible cards took approximately 5 ms using patches versus 224 ms rebuilding; sidecar lookup for 300 episodes took approximately 1.3 ms including indexing versus 1,129 ms using repeated scans. Simulated 24 × 10 ms inspections took approximately 275 / 130 / 67 ms at concurrency 1 / 2 / 4. These are local synthetic measurements, not real media throughput or promised speedups; storage and encoder workload determine end-to-end performance.

Theme files use version 1, a name, light/dark mode, and the 13 color tokens shown in the editor. Only six-digit hexadecimal colors are accepted; imports do not execute CSS or JavaScript. Imported files have a 64 KB size limit. The editor warns about low text contrast but does not prevent saving it. Themes customize colors, not layout or fonts; automatic OS-theme switching is not implemented.

### Folder imports and anime subtitles

Use **Import folder** or drop a folder onto the import area to recursively discover media, including season subfolders. There is no fixed file-count cap; scanning/probing is sequential and can be canceled, while queue memory still limits very large libraries. Overlapping imports are deduplicated. Hidden directory entries, symbolic links, and generated outputs matching the current suffix or standard Audiority/partial filenames are skipped. The output folder itself is not excluded, so importing from the same folder is supported; other unmarked media in that folder is eligible for import. Folder discovery uses a media-extension allowlist; individual file selection can still probe other extensions.

The output preserves the selected root folder and its season paths. For example, importing `Anime/Season 01/Episode 01.mkv` from the `Anime` folder writes `Converted/Anime/Season 01/Episode 01.audiority.mkv`. Already compatible files are skipped rather than copied, so the destination is not necessarily a complete duplicate of the show.

Embedded ASS/SSA tracks and attachments remain stream-copied. Conversion verification compares subtitle/attachment payload hashes, codec header hashes and relevant metadata, including subtitle dispositions. A real FFmpeg regression test covers styled ASS effects and an attachment payload fixture; it is not a glyph-rendering or visual typesetting test.

Matching external `.ass`, `.ssa`, and `.srt` files are copied beside a converted episode, preserving suffixes: `Episode 01.eng.forced.ass` becomes `Episode 01.audiority.eng.forced.ass`. Matching requires an exact media stem or stem followed by a dot in the same directory. Ambiguous matches are flagged rather than assigned. Sidecars are copied, not embedded, and are only exported when the video is converted. External font files/folders are reported but not automatically attached or copied. Subtitle-copy failures produce warnings; review these before treating an export as complete.

ASS preservation does not guarantee client rendering. The app does not convert ASS to SRT or burn subtitles into the video. The selected Plex/Jellyfin client may still need server-side video transcoding or a different player.

Unconvertible tracks remain original with **unresolved compatibility** warnings and never silently downmix. Mixed files can still convert their other tracks, but the app clearly says that the unresolved tracks may not play. Audio conversion does not fix unsupported video hardware decoding and does not guarantee Plex/Jellyfin direct play, subtitle compatibility or container support. No server credentials are requested and nothing is uploaded.

### Legacy compatibility settings (per profile)

Open **Change playback setup → Legacy compatibility · cores, downmixing & exclusions**.

- **Extract compatible DTS core** is enabled by default. Inspection runs `dca_core` on a short sample of extended DTS audio and probes the result. When the profile allows ordinary DTS, a suitable existing core is copied through that filter without another lossy encode. Output verification checks the actual codec profile, sample rate, channels and layout. No usable core means normal conversion rules apply; extraction never invents a 5.1 core. Supported sources are still preserved when preservation is enabled.
- **Allow downmixing** is opt-in; the initial rule is `7.1 → 5.1(side)`. Add/edit rules for known 7.1, 6.1 and 5.1 variants to 5.1(side), 3.1 or stereo. An explicit smaller output takes priority over accepting a larger DTS core. Mixing uses FFmpeg's layout-aware resampler with matrix normalization, then an allowed encoder. DTS in the bundled build does not encode 3.1: automatic selection can fall back to AC-3, but an explicit DTS-only conversion remains unresolved. Stereo PCM remains the only PCM target. Unlisted/unknown layouts are unchanged.
- **Never convert these formats** overrides core extraction, downmixing and per-source conversion rules. DTS and extended DTS have separate selections. Excluding E-AC-3 preserves it at any channel count, even if the receiver profile does not confirm playback; the warning remains visible.

Example for an older receiver: enable core extraction, enable `7.1 → 5.1(side)`, and exclude E-AC-3 only if you want your player to handle it. DTS-HD with a suitable core uses that core; FLAC 7.1 is mixed and encoded to a compatible target; excluded E-AC-3 remains unchanged. Downmixing sacrifices discrete channel positions, and re-encoding removes object metadata. Original input files remain untouched.

Testing includes real 7.1 → 5.1/3.1/stereo conversions, byte-identical excluded E-AC-3 packet checks, and real core-filter output verification. No DTS-HD fixture is included: HD policy decisions are unit-tested, while the filter integration fixture is ordinary DTS.

## Run locally

Requires Node.js 22.12 or newer for the development dependencies.

```sh
npm install
npx --no-install install-electron
npm start
```

FFmpeg and FFprobe are development dependencies with platform-specific binaries. End users of a correctly packaged app do not need Node.js or separately installed tools. If npm blocks the FFmpeg install script, review/approve it or run `node node_modules/ffmpeg-static/install.js`.

```sh
npm test
npm run test:ui
npm audit
```

`npm test` runs policy tests and real conversions of generated media, including mixed audio, stream copying, subtitles, metadata, unchanged inputs, output-name collisions, unsupported 7.1, corrupt input, and cancellation.

## Conversion policy

In the application, the selected playback profile takes precedence over the legacy default table below. Supported sources can remain original even when not a conversion target (for example TrueHD on a capable HDMI path); unsupported DTS/E-AC-3/PCM can be converted. The legacy behavior remains available internally for profile-free engine tests, not as a way to bypass onboarding.

| Source | Action |
| --- | --- |
| DTS, AC-3, E-AC-3 | Copy, including DTS-HD profiles already present |
| PCM stereo | Copy |
| Known lossless stereo | PCM stereo; preserve known integer precision |
| Known lossy stereo | PCM stereo, avoiding another lossy compression stage |
| Known lossless mono/surround | DTS at 1,411,200 bit/s if exact layout is supported |
| Known lossy mono/surround | AC-3, up to 640 kbit/s, if exact layout is supported |
| Unsupported layout, unknown codec/compression | Copy and explain why |

Mono never becomes two-channel PCM. Stereo PCM is larger than lossy stereo, and cannot recover prior losses. DTS/AC-3 both introduce losses; this is a compatibility policy, not a perceptual quality optimizer. Source bitrates across codecs cannot determine the least-lossy result. WavPack is treated as ambiguous because it may be hybrid. No DTS-HD/Atmos encoder is included; re-encoding object-based sources may discard object metadata. DTS uses FFmpeg's experimental `dca` encoder.

Capabilities are queried from the actual bundled encoders. Sample rate is preserved when supported; otherwise the plan explicitly shows resampling. In the current development build, DTS supports `5.1(side)` but not `5.1` (back-surround). Those back-surround tracks remain original rather than changing speaker positions. 7.1+ stays original. Consequently, not every output is restricted to target codecs.

AC-3 can accept some back-surround inputs but signals side-surround on decode; those tracks are also retained to preserve exact speaker positions. AAC with an unreadable/unspecified layout is retained too. This strict safety choice means not every AAC 5.1 source will convert automatically.

## Safety and limitations

- One conversion at a time, streaming via local FFmpeg processes; no whole-file loading and no uploads. CPU encoding; no GPU acceleration claim.
- MKV output. Streams, global metadata, chapters, and compatible attachments/subtitles are mapped. A stream incompatible with MKV fails the file safely rather than being silently discarded.
- Free-space preflight is conservative, not an exact size prediction. Filesystem size limits, damaged/encrypted/DRM media, and FFmpeg decoder support still apply.
- Output verifies stream count, audio codec/channel layout, copied-stream codec, and duration. It does not decode every output packet or prove bit-perfect audio quality.
- Temporary output is removed on handled errors/cancellation. Abrupt system shutdown may leave a hidden `.partial.mkv` file, which can be deleted.
- Final publication uses an atomic hard link in the output folder and chooses a unique name. Output folders must support hard links (APFS/NTFS do; FAT/exFAT do not). Unsupported filesystems fail without modifying originals.
- Queue state is in memory, not persisted across restarts. Cancel stops the current file and leaves later files for a future run. Folder scanning is cancelable with no fixed file-count cap; no application file-size cap, but memory, disk space, and filesystem limits still apply.

## Package for macOS and Windows

Build separately on each target OS/architecture to avoid bundling the wrong tools. The current downloaded arm64 macOS FFmpeg binary reports `--enable-nonfree`, so **public packaging is deliberately blocked**. Do not redistribute it. Replace it with reviewed, legally redistributable binaries and provide matching notices/source information. The application MIT license does not replace third-party licenses.

```sh
export AUDIORITY_FFMPEG=/absolute/path/to/reviewed/ffmpeg
export AUDIORITY_FFPROBE=/absolute/path/to/reviewed/ffprobe
export AUDIORITY_TOOL_NOTICES=/absolute/path/to/license-and-source-notices
npm run dist:mac
```

On Windows PowerShell:

```powershell
$env:AUDIORITY_FFMPEG = 'C:\tools\ffmpeg.exe'
$env:AUDIORITY_FFPROBE = 'C:\tools\ffprobe.exe'
$env:AUDIORITY_TOOL_NOTICES = 'C:\tools\notices'
npm run dist:win
```

`npm run pack` creates an unpacked application. macOS distribution targets DMG/ZIP; Windows targets NSIS installer and portable executable. Supply signing/notarization credentials through electron-builder's environment/configuration before public release. Windows runtime testing and signing remain necessary. Packaging checks the nonfree flag and existence of notices, but is not a legal compliance certification. Review FFmpeg's official licensing requirements and applicable codec licensing before distribution.

## Structure

- `src/policy.js`: conservative per-track decisions.
- `src/catalog.js`: offline receiver/device directory, capability confidence, and manufacturer references.
- `src/profiles.js`: settings validation, playback-chain constraints, and source profile identification.
- `src/settings.js`: safe local settings loading/saving.
- `src/profile-library.js`: named profiles, migration, validation, atomic library persistence and recovery backup.
- `src/themes.js`: validated built-in/custom palettes and appearance persistence.
- `src/app-state.js`: application preferences, statistics accounting/storage and ordered bounded inspection.
- `src/ui/pages.js`: Settings/Statistics navigation and rendering.
- `scripts/benchmark.js`: repeatable synthetic queue/sidecar/inspection benchmarks.
- `src/imports.js`: recursive discovery, safe output paths and subtitle-sidecar matching.
- `src/engine.js`: probe, encoder capabilities, process execution, progress, cancellation, safe publication and verification.
- `src/main.js`: trusted desktop IPC, dialogs and sequential queue.
- `src/preload.js`: narrow sandbox bridge.
- `src/ui/`: offline user interface, with text-only file rendering and restrictive CSP.
- `src/ui/onboarding.js`: searchable receiver selector, custom rules, playback setup and saved-profile navigation.
- `src/ui/appearance.js`: theme selection, live editing and import/export controls.
- `scripts/prepare-tools.js`: platform-specific tool bundling and distribution gate.