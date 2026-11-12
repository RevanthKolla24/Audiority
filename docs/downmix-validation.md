# Downmix validation and limits

Audiority uses FFmpeg's speaker-aware rematrixing, with `rematrix_maxval=1`
and explicit `lfe_mix_level=0`. The latter preserves the existing default:
LFE stays discrete for LFE-equipped targets, but is not folded into stereo.
This is not speaker bass management. Center and surround content are folded
into stereo; they are not simply discarded. Summed channels require headroom,
so normalization may lower every output channel, including center and LFE.

Standard 7.1 to 5.1(side) preserves front/center/LFE identities and combines
rear-left with side-left, rear-right with side-right. Wide layouts have
different speaker identities and must not use positional channel-count guesses.
6.1(front) lacks a discrete center. Legacy profiles remain readable, but rules
requesting a center-equipped output from it now remain unchanged/unresolved.
Stereo remains supported. No artificial center is synthesized.

`src/audio-processing.js` supplies the same filter definitions to command
construction and conversion reports. Reports distinguish retained originals
from filtered compatibility tracks. Center boost is optional 1.5× gain for
7.1-family to 5.1 downmixes, not speech isolation. Dynamic normalization changes
gain over time; it is optional and is not a transparent mastering operation.
Copied and core-extracted streams do not receive these filters.

`test/downmix-routing.test.js` uses independent numeric coefficient tables,
activating each source speaker separately. It checks routing and gain for
standard 7.1 to 5.1/3.1/stereo, wide variants to 5.1, ordinary/back 6.1 to 5.1,
front 6.1 to stereo, and 5.1 variants to stereo/3.1. The oracle does not parse
FFmpeg's own debug matrix. Any tool-version matrix change requires review.

Additional real conversions exercise AC-3 and DTS with correlated 100 Hz,
0.9-peak signals and all four center-boost/normalization combinations, then
decode to floating-point PCM and assert finite samples and sample peaks below
full scale. These are regression fixtures, not a universal clipping guarantee.
They do not measure intersample true peaks or every possible signal/codec rate.
Existing low-level tone fixtures check center-only boost relative to other channels.

Remaining acceptance: more signal families and rates, encoded per-speaker isolation,
all remaining layout/target combinations, true-peak measurements, and level-matched
listening on the actual player/receiver. Correct layout metadata alone cannot prove
speaker routing, perceptual quality, player track selection or receiver passthrough.
Keep originals and leave Auto-Trash off during listening comparisons.