# DTS-HD acceptance status and remaining gates

## Implemented safeguards

- Extraction compares the complete source core and output audio payload using a
  streaming SHA-256 hash muxer. No reference media file is written.
  Hash output and FFmpeg progress use separate pipes. A five-minute watchdog
  bounds lack of advancing media timestamps, not total job duration; repeated
  heartbeat records do not reset it. Cancellation/stall failures wait for process
  closure before callers clean up temporary outputs.
- Changed audio is decoded across the full output duration with strict FFmpeg
  error handling before publication. This is verification, not another encode.
- Chapter count/times/tags and stable source global tags are checked. Muxer-owned
  encoder/duration and input-container brand tags are exempt.
  Valid timezone-qualified creation timestamps compare at UTC microsecond
  precision; invalid/timezone-less values remain literal. Only the recognized
  performer/LEAD_PERFORMER and track/PART_NUMBER aliases are canonicalized, with
  conflicting values rejected rather than silently discarded.
- Explicit disk-full subprocess diagnostics and publication failures preserve
  `ENOSPC` for the existing queue-stop branch.
- The non-publishing Windows workflow runs regression, GUI/restart checks and
  packaging/resource validation without requiring or publishing a release tag.

## Not signed off

No genuine DTS-HD MA/HRA fixture or Garden of Words movie was converted in this
audit. No installed Windows 11 application was executed. Ordinary DTS integrity
tests and macOS simulated Windows layout smoke do not satisfy either gate.

The opt-in test in `test/genuine-dtshd.test.js` requires explicit consent and a
short genuine fixture. Its normal skipped result must never be reported as a
successful DTS-HD conversion. Run it independently for MA and HRA on native
platforms and retain tool versions, source hash, logs and timing diagnostics.

The following still require implementation or manual acceptance:

1. Packet-level relative A/V/subtitle timing checks, with container time-base
   rounding and legitimate common timestamp shifts handled explicitly.
2. Late-corruption decode fixtures, channel-identity/LFE fixtures and coverage of
   retained-original plus extracted-output mappings using genuine HD sources.
3. Installed Windows 11 internal/external-drive, Unicode/long-path, permissions,
   interrupted conversion, disk-exhaustion and restart acceptance.
4. Full-movie decode and target-player synchronization/rendering checks, using a
   separate output only after owner consent and scratch-space approval.
5. Representative conversion/verification/publication timings, child CPU/memory
   and disk I/O observations. Do not infer full-film throughput from short tests.

The two-second inspection sample writes a small temporary core. Use direct
FFprobe for strictly read-only inspection before obtaining conversion consent.
Keep Auto-Trash off and record source hashes before and after acceptance.

No release version/tag is changed by this work. The existing v1.5.0 release must
remain unchanged; publication requires a separately approved version and all
native/media acceptance gates.