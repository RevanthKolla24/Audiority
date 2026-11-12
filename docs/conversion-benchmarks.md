# Conversion stage measurements

Completed conversions return and save `timings` with the queue record. Values are
monotonic elapsed seconds: `conversion`, `structure`, `video`, `audio`,
`subtitlesAndAttachments`, `publication`, and `total`. Old records need no migration.
These are successful-job measurements, not failure/cancellation telemetry.

Conversion measures the FFmpeg process; verification stages measure the existing
checks unchanged. Publication includes media publication, temporary-file cleanup,
the publication callback and external subtitle handling. Total also includes
preflight and identity/persistence callbacks, so stage sums need not equal total.
Timings are not yet shown in the UI or aggregated in Statistics.

From the project root, with local media-tool overrides configured if necessary:

```sh
AUDIORITY_FFMPEG=./legal-tools/ffmpeg AUDIORITY_FFPROBE=./legal-tools/ffprobe npm run benchmark:conversion -- 15 3
```

This generates disposable video, distinct per-channel tones in a 5.1 main track
and two stereo tracks, plus one subtitle. It retains the original main track and
adds its compatibility version, alternating Balanced/Adaptive order. Its private
temporary directory is removed on success or failure. It does not load personal
settings or delete/import user media. JSON output includes raw runs, stage medians,
tool versions, planned audio actions, sizes and parent CPU measurements.
Each run also includes the actual source-to-output audio mapping, codecs, channel
counts/layouts, metadata and default flags. Successful app jobs expose the same
copyable report in their job details; queue snapshots preserve reports and timings
across reloads. Reports describe files, not selected player tracks or passthrough.

Limitations: short synthetic media, no fonts, one conversion at a time, no cache
flush, no child CPU/disk-byte measurement. It is not a representative movie,
parallel queue, Windows or receiver-playback benchmark. Adaptive may not have
time to ramp up. Do not infer audio quality or full-film throughput from it.

Initial mono-fixture local 15-second/three-repeat sample: Balanced total median 0.236 s,
Adaptive 0.268 s. Raw report: `/tmp/audiority-stage-benchmark.json` (ephemeral).
The test suite ran alongside this sample, so it is instrumentation validation,
not an isolated performance comparison. Full-content verification remains enabled.

Next: isolated representative multitrack/subtitle/font workloads, sequential versus
bounded reads, and disk/cache/CPU observations.
Only then compare a consolidated packet-scan prototype against independent
wrong-track, reordered and corrupt-payload fixtures. Keep Auto-Trash off for
manual media investigations.