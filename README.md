<p align="center">
  <img src="src/assets/logo.png" alt="Audiority logo" width="128">
</p>
<h1 align="center">Audiority</h1>
<p align="center"><strong>Local, channel-safe MKV audio conversion for home theaters.</strong><br>Prepare your audio for your receiver. Keep your video and anime typesetting intact.</p>
<p align="center">macOS Apple Silicon · Windows x64 · Version 1.0.0 · MIT application license</p>

---

Audiority turns playback compatibility into a reviewable plan. Pick your receiver and playback path, import media, and prepare compatible audio locally—with no uploads or server credentials.

Video is copied without re-encoding. Outputs are new MKV files; sources stay in place unless you explicitly enable Auto-Trash.

## ✨ Key features

- 🎧 **Smart DTS / Dolby Digital conversion** — profile-aware decisions, compatible DTS-core extraction and PCM stereo output.
- 📺 **Plex / Jellyfin playback profiles** — save named receiver, player and connection setups with custom rules.
- 🎨 **Dynamic themes** — 12 presets, custom palettes and theme-matched runtime window/Dock icons.
- 📂 **Whole-show imports and watch folders** — recursive season discovery, deduplication and optional background MKV imports.
- 🈶 **Anime-friendly preservation** — preserve and verify ASS/SSA subtitles and embedded fonts; copy matching subtitle sidecars.
- 🛟 **Recoverable queues** — restore pending jobs after restart, prioritize files and pause between conversions.
- 🔊 **Compatibility tracks** — optionally retain original audio alongside a converted track, with approved downmixing and normalization.
- 📊 **Private statistics** — processed GB, track operations and recent activity, stored locally without telemetry.

> **Compatibility, not magic:** DTS/AC-3 encoding is lossy. Audiority does not guarantee Plex/Jellyfin direct play or fix unsupported video decoding. Channels are preserved unless you approve a downmix.

## 📥 Installation

### Updates

Packaged applications check GitHub Releases at startup. Windows downloads newer
installers in the background and offers **Install and restart** once work is idle.
Installation saves the queue first and may request administrator permission.
Choose **Later** to continue without installing; ordinary quits do not install updates.

Unsigned macOS builds check for new versions but do not download or install them
automatically. Their prompt opens the official release page for a manual download.
Development runs (`npm start`) do not check for updates. Existing releases without
this feature require one manual upgrade to a build that includes it.

Update checks contact GitHub and its download infrastructure; this is network
activity, not conversion telemetry. Conversions still run locally. CI publishes
the macOS ZIP and `latest-mac.yml`, and Windows installer, blockmap and `latest.yml`.
Future signed macOS auto-installation requires a separate implementation change.

Use the installer supplied by the project maintainer. A public download URL is not configured here yet; generated installers are available in `dist/` for local builds.

| Platform | Installer | Architecture |
| --- | --- | --- |
| macOS | `Audiority-1.0.0-arm64.dmg` | Apple Silicon |
| Windows | `Audiority Setup 1.0.0.exe` | x64 |

Packaged applications include FFmpeg and FFprobe. End users do not need Node.js or a separate FFmpeg installation.

### macOS — Apple Silicon

1. Open the DMG and review the license agreement.
2. Drag **Audiority** into **Applications**.
3. Open Audiority from Applications.

**Unsigned release:** the current build is not Developer ID signed or notarized. If macOS blocks an unidentified developer, first try opening the app, then use **System Settings → Privacy & Security → Open Anyway**, only if you trust the source. Do not disable Gatekeeper globally or override malware warnings. Installation authorization depends on account permissions.

### Windows — x64

1. Run `Audiority Setup 1.0.0.exe`.
2. Review the license, choose a destination and complete the wizard.
3. Approve the Administrator/UAC prompt for the per-machine installation. Normal use does not require running as Administrator.

**Unsigned release:** SmartScreen may report an unrecognized app. If you trust the download and the option is available, select **More info → Run anyway**. Organizational policies or Smart App Control may prevent this override; do not disable system protections to install the app.

**Release status:** both installers have been generated. Native Windows installation/conversion testing, signing/notarization and final third-party license/source review remain outstanding. Packaging success is not a security or compatibility certification.

## 🚀 Quick start

### 1. Choose your playback setup

Name your profile, search for your receiver, and specify the player and connection—for example, Jellyfin on Fire TV over HDMI. Catalog entries distinguish verified documentation, user reports and directory-only models; a listed name is not proof of compatibility.

Use **⚙ Edit Advanced Audio Rules** when you need custom conversion settings. Saving the profile persists them; Done/Escape only closes the editor.

### 2. Import files or a show folder

Use the import buttons or drag media onto the import area. Folder imports discover season subfolders. Expand a file's plan to review its audio actions and warnings.

Choose **Default Output Folder** in Settings, or click **Exporting to: …** in the queue footer. Same-folder imports and exports are supported.

### 3. Convert and review

Select **Convert queue**. Audiority processes one file at a time, shows percentage and estimated conversion time, then verifies before reporting Complete.

- **Pause** finishes the active job before starting another.
- **↑ Move to Top** prioritizes a Ready item without interrupting current work.
- **Cancel queue** stops processing safely, leaving later items pending.
- **Show converted file** reveals the finished output.

Already-compatible files are skipped rather than copied. Folder output is therefore not necessarily a complete duplicate of your show. Wait for **Complete** before using the output.

## ⚙️ Advanced configuration

- **Watch folders:** Settings → Automation imports stable-looking MKVs every 30 seconds while the app is open and idle. It does not automatically start conversion. A stalled download can still look stable.
- **Auto-Trash:** off by default; moves source media to the OS Trash only after verified publication. Test playback and keep backups first—without compatibility tracks, this could move your only lossless copy to Trash.
- **Conversion Matrix:** customize source actions, allowed codecs, bitrates, exclusions and explicit layout downmix rules. PCM output is stereo only; exclusions override transformations.
- **Compatibility tracks:** retain originals and append converted/core-extracted audio, with a compatible default selected where applicable. Outputs are larger.
- **Languages:** use tags such as `eng, jpn`; unknown-language tracks remain, and default/forced protection is enabled initially. A blank profile list inherits global settings.
- **Themes and stats:** Appearance lives in Settings. Statistics counts full source-file bytes for verified outputs—not bytes of audio re-encoded. Filenames are opt-in; queue recovery still requires local media paths.

ASS preservation does not guarantee client rendering. There is no automatic ASS-to-SRT conversion or burn-in. External fonts are detected but not automatically attached. Audio encoding cannot preserve Atmos objects or promise nearly lossless DTS/AC-3 output.

## 🧰 Developer & architecture notes

The reference below documents detailed operation, safety guarantees, policy and contributor workflows. It is intentionally separate from the everyday quick start.

#### Reference: automation and processing

#### Watch folders

Settings → Automation lets you choose a folder and enable MKV imports. Save
settings to apply. The app polls recursively every 30 seconds while idle and
requires two matching size/modification-time observations. A stalled download
can still appear stable: this is not a guarantee that copying has finished.
Generated outputs are skipped. Input symlinks are followed and canonical targets
are deduplicated; the watch root itself must remain a real directory. Successfully
queued paths are remembered while present; removed paths are pruned after a
successful scan, and failures can retry.
Restarting or changing watch settings resets that memory. Existing queue entries
remain deduplicated. Imports use the active profile and the usual inspection
pipeline. Conversions are **not automatically started**. Watching only runs while
the app is open, and a configured playback profile is required.

#### Auto-trash originals (optional)

Settings → Processing offers **Move originals to Trash after successful conversion**.
It defaults off and uses the operating system Trash/Recycle Bin, never permanent
deletion. Only source media is moved, after conversion, verification and output
publication succeed. External subtitle sources stay untouched. Canceled jobs and
failed sidecar copies retain the original. OS failures become card warnings and do
not invalidate the completed output. A verified output path is saved before the
Trash operation for restart recovery. This may remove your only lossless copy if
compatibility tracks are disabled; test playback and maintain backups first.

#### Queue pausing

Use **Pause** beside Cancel queue to stop the queue from starting its next job.
The active conversion, verification, publication and statistics recording finish
normally; pausing does not suspend FFmpeg midway through an output. **Resume**
continues with the next eligible job, respecting updated priorities. Canceling or
quitting wakes a paused queue so shutdown cannot get stuck waiting for Resume.
Pause state resets when a run ends and is not persisted across restarts. Pausing
during the final job does not prevent completion: the run ends automatically when
no eligible work remains. Resume rescans priorities before selecting the next job.

#### Language filtering

Settings → Processing and Advanced Audio Rules accept comma-separated three-letter
language tags, such as `eng, jpn`. A nonempty profile list overrides the global list;
an empty profile list inherits Settings. An empty global list disables filtering.
Untagged, blank-language and `und` streams always stay. By default, streams marked
default **or forced** also stay regardless of language; this protection can be disabled.
Matching is case-insensitive, but alternate three-letter aliases are not automatically
translated (use the codes actually present in the file).

Filtering removes only embedded audio and subtitle streams. Video and attachments
are retained and verified; external subtitle sidecars are unchanged. Filtering alone
creates a remuxed output even when audio needs no encoding. If all tagged audio is
excluded and default protection is disabled, an output can intentionally contain no
audio. Original media is never modified. Re-importing or replanning uses current
language settings; already completed outputs are not retroactively edited.

### Queue priority

Click **↑ Move to Top** on a Ready item to prioritize it. Most recently prioritized items appear first on page 1 and are chosen first when the runner selects its next job. The current conversion is never interrupted. Unprioritized jobs keep their insertion order.

Priority is stored in the local queue file and survives recovery. Completed items retain their ordering but are not run again. Error/Cancelled jobs remain eligible for a later queue run, with at most one attempt per job in each run. Only Ready items can receive a new priority; import/settings operations must finish first.

### Optional compatibility tracks

Enable **Create compatibility track** in Advanced Audio Rules for a profile, or in Settings → Processing globally. Both default to off; either enabled setting retains originals. Old saved settings default to off.

For each encoded or DTS-core-extracted track, the original is copied unchanged and a compatibility track is appended. This includes lossy sources, not only lossless audio. Excluded and copy-only tracks are not duplicated. Downmixing and normalization affect only the appended track. Plans display “Keep original + compatibility track”.

The compatibility counterpart of the original default audio becomes the default. If no original default exists, the first compatibility track is selected. Otherwise the existing default is retained; only one default is selected. Languages and original titles are preserved, and new tracks receive a compatibility title. Players can still override default flags.

Outputs are larger and retained originals require extra packet verification. Compatible files still skip conversion. Statistics count processed source tracks, not the resulting total audio-stream count. Real DTS-HD core extraction still needs a dedicated regression fixture.

### Optional volume normalization

Enable volume normalization in **Settings → Processing**, or for one playback profile in **Advanced Audio Rules**. Both default to off; either enabled setting activates it. Older saved settings without this field default to off.

Only tracks already planned for re-encoding receive `dynaudnorm=f=150:g=15`. Approved downmixing runs first in the same filter chain. Copied tracks, exclusions and DTS-core extraction remain unchanged; normalization alone does not create an output for an otherwise compatible file.

This changes overall audio dynamics, not dialogue independently. It is not a fixed loudness-target pass and cannot guarantee artifact-free results. Preview representative scenes before processing a whole library.

A local Electron desktop app for macOS and Windows. Import videos, review the automatically generated per-track plan, choose a folder, and convert. Video is copied without encoding; the app writes a new MKV and never replaces the input.

### Receiver and playback setup

On first launch, complete the two-page setup:

1. **Receiver:** type a brand/model into the alphabetical searchable dropdown (keyboard arrows/Enter supported). The offline directory contains 126 receiver/home-theater models across Bose, Denon, Marantz, Onkyo, Pioneer, Sony and Yamaha. Entries distinguish documented presets, user-reported presets, and directory-only models. A listed name does **not** mean verified compatibility.
2. **Playback path:** choose Plex, Jellyfin, local or other; pick the device; describe your app, HDMI/ARC/eARC/optical/coaxial connection, optional TV model and passthrough setting. Unknown paths default conservatively to PCM stereo. To enable unverified formats, explicitly confirm the complete app/device/TV path.

Nine documented receiver presets currently cover Denon AVR-X1800H/X2800H/X3800H/X4800H/A10H, Marantz CINEMA 50/60/70s, and Bose Lifestyle 50. Their manufacturer references are stored with the catalog entries. Bose Lifestyle V20 uses the project owner's reported DTS/AC-3/PCM stereo compatibility, with conservative 16-bit/48 kHz PCM ceilings; its full input-limit matrix is not verified. The remaining 116 directory entries require Advanced capability confirmation. Sony STR-DH790 is deliberately directory-only because the retrieved manufacturer troubleshooting page is not a complete capability table.

Thirteen playback-device choices include Apple TV 4K, NVIDIA SHIELD TV/Pro, and clearly unverified generic/model-dependent entries. A documented output specification is only an upper bound, not a certified client/file compatibility profile. Device, firmware and player settings must be checked on the user's actual system. TV model and app/version text are descriptive; no automatic TV/app capability lookup or server/device discovery is performed.

**Advanced** can replace receiver selection, choose allowed DTS/AC-3/PCM targets, control source preservation, set preferences and valid bitrate/PCM ceilings, and add per-source/channel-scope rules. Explicit target rules do not silently fall back. Stereo-specific rules win over all-channel rules. Custom capabilities are user-confirmed rather than manufacturer verified. Preferences fall back to another allowed encoder only when exact layout preservation is possible.

The chosen receiver, player/connection restrictions, confirmed path formats and actual encoder capabilities all constrain conversion. DTS-HD and DTS core are distinct; an AC-3-only receiver no longer automatically preserves E-AC-3. PCM precision/rate reductions are displayed explicitly. ARC/S/PDIF conservatively excludes HD formats; unconfirmed TV passthrough is not assumed to work. Multichannel PCM is still not a conversion target.

#### Multiple named profiles

Create as many named profiles as you need: there is no artificial profile-count limit (available memory/storage still applies). The sidebar supports search, selection, and **New profile**. Each profile independently stores receiver, playback path, custom rules, and codec limits. **Edit**, **Rename**, **Duplicate**, and **Delete** manage the active profile. Names are limited to 100 characters; duplicate names are allowed and profiles are identified by unique IDs.

Settings are saved locally in Electron's user-data directory as `playback-profiles.json`, using validated main-process IPC and atomic file replacement. The previous valid library is retained as `playback-profiles.json.backup`. An existing single `playback-profile.json` is automatically migrated to a profile named **My playback setup**, with the legacy file left intact. Corrupt libraries are not overwritten; restore the backup or move the damaged file aside before saving.

Subsequent launches restore the active profile. Switching profiles or editing active conversion settings recalculates queued plans and resets previous output results without deleting generated files. Renaming alone does not reset results. Profile operations are rejected during imports/conversions. Deleting the active profile selects the first remaining profile; deleting the last returns to setup. Canceling an edit/new profile discards the draft. Conversion uses one active profile for the entire queue; there is no automatic multi-profile batch export or per-file profile selection.

#### Desktop workflow

The interface uses a persistent searchable profile sidebar, compact active-profile actions, an expandable compatibility-notes section, and collapsed per-file track plans. **Settings → About Audiority** contains an in-app description and limitations. Receiver setup keeps advanced controls in the **Edit Advanced Audio Rules** modal; Done or Escape closes it without saving the profile. Output selection lives in Settings, with a clickable **Exporting to** shortcut in the queue footer. The UI requires a minimum 960×680 desktop window.

#### Themes

Open **Settings → Appearance** for grouped palette previews of 12 presets: Warm Light, Graphite Dark, Midnight, High Contrast, Paper, Sandstone, Ocean Light, Rose Light, OLED Black, Forest Dark, Slate and Plum Dark. Theme selection, custom color editing and JSON import/export are all available inline in Settings. Create a custom theme from the current palette, preview its colors, name it, and save it. Custom themes can be edited or deleted, and themes can be exported/imported as JSON. Selection and custom palettes persist locally in `appearance.json`, independently of playback profiles. Deleting the active custom theme restores Warm Light.

#### Application settings and statistics

Use **Queue / Statistics / Settings** navigation. App-wide preferences are saved in `app-settings.json`, with validation, atomic replacement and a previous-valid-file backup. Receiver, exclusion and downmix rules remain per profile.

Settings include compact queue, reduced motion, remembering the output destination (on by default), preserving imported season structure, output suffix, encoder threads (automatic or a limit), 1–4 concurrent inspections (default 2), idle sleep prevention during conversion, and local statistics privacy. Changes save only while import/conversion is idle. Thread settings are hints to supported encoders, not a strict CPU cap; DTS encoding in this build has no threading support. Display sleep is permitted. Diagnostics exports include application/tool versions and encoder capabilities, not media filenames, paths or credentials.

Statistics are stored locally in `statistics.json`. Completed means a newly generated output passed verification. **Source data processed** counts the full size of successful source files, not the amount of audio re-encoded. **Output written** counts the resulting MKV bytes, excluding subtitle sidecars. GB is decimal (1,000,000,000 bytes). Source/output sizes are not a claim about compression efficiency or audio quality. Failed/cancelled attempts contribute processing time and attempt counts, but not successful bytes or track counts. Retrying failed work only adds successful bytes on completion; deliberately producing another output counts as another operation. Already-compatible/skipped files and import failures are not conversion attempts.

Counters include encoded/copied audio tracks, DTS-core extraction, downmixing, processing time, media duration, codec pairs, profile breakdown and UTC daily activity. Lifetime totals persist; daily breakdown is bounded to 366 days (the page shows the latest 30), recent history to 200 attempts, and profile breakdown to 1,000 names with an overflow bucket. History begins with this feature, not earlier conversions. Profile names are recorded; media filenames are opt-in, full paths never are. Disabling filename storage purges recorded filenames and the previous statistics backup. Disabling recording pauses new events without deleting history. Export and explicitly confirmed reset are available; exported files are the user's responsibility. Valid new application state can replace malformed or schema-invalid saved data without replacing a good backup; filesystem read and backup-write errors still block saves. A statistics save failure is surfaced without marking a verified media conversion as failed. History is not crash-resumable: a crash between output completion and statistics persistence can leave a completed output uncounted.

#### Efficiency changes and benchmark

Progress messages are throttled, active cards are patched instead of rebuilding the queue, profile navigation is cached until its inputs change, and hidden application pages avoid queue rendering. Inspection runs in a bounded ordered pipeline. Sidecar association is indexed once per imported directory. External subtitle files and FFprobe verification output are hashed incrementally, retaining preservation checks without accumulating complete packet JSON in memory. Queue state still uses memory; these are not unlimited-library or encoding-speed guarantees.

Run `npm run benchmark` for a synthetic Electron benchmark. On the development machine, 200 progress updates with 5,000 queued files / 50 visible cards took approximately 5 ms using patches versus 224 ms rebuilding; sidecar lookup for 300 episodes took approximately 1.3 ms including indexing versus 1,129 ms using repeated scans. Simulated 24 × 10 ms inspections took approximately 275 / 130 / 67 ms at concurrency 1 / 2 / 4. These are local synthetic measurements, not real media throughput or promised speedups; storage and encoder workload determine end-to-end performance.

Theme files use version 1, a name, light/dark mode, and the 13 color tokens shown in the editor. Only six-digit hexadecimal colors are accepted; imports do not execute CSS or JavaScript. Imported files have a 64 KB size limit. The editor warns about low text contrast but does not prevent saving it. Themes customize colors, not layout or fonts; automatic OS-theme switching is not implemented.

#### Folder imports and anime subtitles

Use **Import folder** or drop a folder onto the import area to recursively discover media, including season subfolders. There is no fixed file-count cap; discovery is cancelable and inspection uses bounded concurrency, while queue memory still limits very large libraries. Overlapping imports are deduplicated. Hidden directory entries and generated outputs matching the current suffix or standard Audiority/partial filenames are skipped. The output folder itself is not excluded, so importing from the same folder is supported; other unmarked media in that folder is eligible for import. Folder discovery uses a media-extension allowlist; individual file selection can still probe other extensions.

The output preserves the selected root folder and its season paths. For example, importing `Anime/Season 01/Episode 01.mkv` from the `Anime` folder writes `Converted/Anime/Season 01/Episode 01.audiority.mkv`. Already compatible files are skipped rather than copied, so the destination is not necessarily a complete duplicate of the show.

Embedded ASS/SSA tracks and attachments remain stream-copied. Conversion verification compares subtitle/attachment payload hashes, codec header hashes and relevant metadata, including subtitle dispositions. A real FFmpeg regression test covers styled ASS effects and an attachment payload fixture; it is not a glyph-rendering or visual typesetting test.

Matching external `.ass`, `.ssa`, and `.srt` files are copied beside a converted episode, preserving suffixes: `Episode 01.eng.forced.ass` becomes `Episode 01.audiority.eng.forced.ass`. Matching requires an exact media stem or stem followed by a dot in the same directory. Ambiguous matches are flagged rather than assigned. Sidecars are copied, not embedded, and are only exported when the video is converted. External font files/folders are reported but not automatically attached or copied. Subtitle-copy failures produce warnings; review these before treating an export as complete.

ASS preservation does not guarantee client rendering. The app does not convert ASS to SRT or burn subtitles into the video. The selected Plex/Jellyfin client may still need server-side video transcoding or a different player.

Unconvertible tracks remain original with **unresolved compatibility** warnings and never silently downmix. Mixed files can still convert their other tracks, but the app clearly says that the unresolved tracks may not play. Audio conversion does not fix unsupported video hardware decoding and does not guarantee Plex/Jellyfin direct play, subtitle compatibility or container support. No server credentials are requested and nothing is uploaded.

#### Legacy compatibility settings (per profile)

Open **Edit playback setup → Edit Advanced Audio Rules → Conversion Matrix**.

- **Extract compatible DTS core** is enabled by default. Inspection runs `dca_core` on a short sample of extended DTS audio and probes the result. When the profile allows ordinary DTS, a suitable existing core is copied through that filter without another lossy encode. Output verification checks the actual codec profile, sample rate, channels and layout. No usable core means normal conversion rules apply; extraction never invents a 5.1 core. Supported sources are still preserved when preservation is enabled.
- **Allow downmixing** is opt-in; the initial rule is `7.1 → 5.1(side)`. Add/edit rules for known 7.1, 6.1 and 5.1 variants to 5.1(side), 3.1 or stereo. An explicit smaller output takes priority over accepting a larger DTS core. Mixing uses FFmpeg's layout-aware resampler with matrix normalization, then an allowed encoder. DTS in the bundled build does not encode 3.1: automatic selection can fall back to AC-3, but an explicit DTS-only conversion remains unresolved. Stereo PCM remains the only PCM target. Unlisted/unknown layouts are unchanged.
- **Never convert these formats** overrides core extraction, downmixing and per-source conversion rules. DTS and extended DTS have separate selections. Excluding E-AC-3 preserves it at any channel count, even if the receiver profile does not confirm playback; the warning remains visible.

Example for an older receiver: enable core extraction, enable `7.1 → 5.1(side)`, and exclude E-AC-3 only if you want your player to handle it. DTS-HD with a suitable core uses that core; FLAC 7.1 is mixed and encoded to a compatible target; excluded E-AC-3 remains unchanged. Downmixing sacrifices discrete channel positions, and re-encoding removes object metadata. Original input files remain untouched.

Testing includes real 7.1 → 5.1/3.1/stereo conversions, byte-identical excluded E-AC-3 packet checks, and real core-filter output verification. No DTS-HD fixture is included: HD policy decisions are unit-tested, while the filter integration fixture is ordinary DTS.

### Run locally

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

### Conversion policy

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

### Safety and limitations

- One conversion at a time, streaming via local FFmpeg processes; no whole-file loading and no uploads. CPU encoding; no GPU acceleration claim.
- MKV output. Streams, global metadata, chapters, and compatible attachments/subtitles are mapped. A stream incompatible with MKV fails the file safely rather than being silently discarded.
- Free-space preflight is conservative, not an exact size prediction. Filesystem size limits, damaged/encrypted/DRM media, and FFmpeg decoder support still apply.
- Output verifies stream count, audio codec/channel layout, copied-stream codec, and duration. It does not decode every output packet or prove bit-perfect audio quality.
- Temporary output is removed on handled errors/cancellation. Startup cleanup completes before processing and scans known output directories for strict hidden UUID-named Audiority partial files. Recorded interrupted-job cleanup also runs. Symlinks and unrelated partial filenames remain untouched; unavailable or locked paths do not block startup.
- Final publication prefers an atomic hard link and chooses a unique name. When hard links are unavailable, an exclusive-copy fallback refuses existing destinations and requires space for a second complete output copy. This fallback is not atomic: the final filename is visible during copying, and a crash can leave an incomplete final-named file that recovery does not delete automatically. Wait for Complete before playing/importing the output. Copy publication uses an abortable stream. Handled failures and cancellation remove the incomplete destination created by this operation; existing collision files are never deleted. Cleanup failures are reported, and hard crashes can still leave incomplete final-named files. FAT32 still cannot store files larger than 4 GiB minus 1 byte; exFAT does not have that FAT32 limit. External-drive support must still be validated on actual drives and Windows.
- Queue records persist in local `queue.json` with atomic replacement and a previous-file backup. Startup asks Restore Queue / Discard for unfinished queues. Restored sources are re-inspected against the active profile; interrupted conversions restart from the beginning, never from a partial file. Missing sources are flagged. Completed outputs remain unless **Settings → Queue recovery → Clear completed files from queue on app restart** is enabled (off by default). Discard clears the saved queue without deleting completed outputs or sources. Queue storage necessarily includes source, sidecar, output and temporary paths even when statistics filenames are disabled. Corrupt queue data can be replaced by a validated queue snapshot; existing valid backups are preserved and filesystem errors still block saves. Cancel leaves later jobs pending. Folder scanning is cancelable with no fixed file-count cap; memory, disk space and filesystem limits still apply.

### Package for macOS and Windows

Target-specific cross-building is configured and both 1.0.0 installers have been generated. Validation rejects nonfree builds but does not certify redistribution compliance. Review matching notices and corresponding-source obligations; the application MIT license does not replace third-party licenses. Native platform testing and signing remain outstanding.

```sh
# Put arm64 macOS tools and ffmpeg-license.txt in legal-tools/ first.
npm run dist:mac
```

On Windows PowerShell:

```powershell
# Put Windows x64 tools and their ffmpeg-license.txt in legal-tools-win/ first.
npm run dist:win
```

`npm run pack` creates an unpacked application. Release targets are macOS DMG and Windows NSIS installer (ZIP/portable targets are intentionally excluded). Both explicitly reference `build/license.txt`, also bundled as a resource. This is a release-review draft containing the existing MIT license and a local-data notice, not an approved bespoke EULA or legal compliance certification; the owner must review it before distribution.

NSIS uses an assisted setup wizard, allows destination selection, and installs per-machine with elevation. Administrator authorization is for installation, not a requirement to run the app elevated. DMG uses electron-builder's explicit license configuration for mount-time acknowledgement. macOS authorization when copying to Applications depends on account permissions and system configuration; a password prompt is not guaranteed.

Release scripts validate the selected target before invoking electron-builder. `npm run prepare:tools` validates both folders without copying anything; per-target scripts validate only their own folder. macOS bundles `legal-tools/` and Windows bundles `legal-tools-win/` directly as `resources/tools`, including supplied notices. Environment overrides still select development/test tools but do not change release resources. `src/tools.js` already resolves this packaged location.

Validation checks native executable headers and rejects embedded `--enable-nonfree`. Compatible host binaries are also executed; foreign Windows binaries on macOS receive static checks only. Cross-building is supported by the configuration, but successful Windows installation and conversion still require native Windows testing. Each target must have its own nonempty `ffmpeg-license.txt`; presence is not a legal compliance certification. Review matching source distribution, build configurations, third-party notices and applicable licensing before public distribution. Supply signing/notarization credentials separately. The application agreement remains an owner-review draft. Newer FFmpeg compatibility-track mappings put attachments last and explicitly copy their codecs, preserving fonts rather than dropping them.

### Structure

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
- `scripts/prepare-tools.js`: in-place target-specific tool validation and distribution gate.

### Symlinked inputs and dialogue boost

Input file and directory symlinks are followed, including targets outside the selected folder. Canonical paths prevent repeated traversal of directory cycles and duplicate targets within a scan; broken or unresolvable links are skipped with warnings. Generated-output checks cover both the link name and target name. Output subfolder symlinks remain prohibited. Sidecar matching still uses imported directory entries; symlinked subtitle sidecars are not automatically followed.

**Auto-Trash acts on the resolved media target, not the symbolic link.** Disable Auto-Trash if that target is shared with another library or application.

Dialogue boost recognizes `7.1`, `7.1(wide)`, and `7.1(wide-side)` sources when a matching downmix rule explicitly permits conversion to 5.1. It still requires the boost setting, affects only the center channel, and may clip loud peaks. It does not automatically authorize new downmix rules.

Profile-library saves can replace malformed or schema-invalid data while preserving the last valid backup. Filesystem read or backup-write failures still block replacement. If legacy migration cannot be saved, the migrated profile remains usable in memory with a warning; it must be saved successfully to persist across restarts.
