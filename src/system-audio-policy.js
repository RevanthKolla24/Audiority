const speakerCounts = { stereo: 2, '3.1': 4, '5.1(side)': 6, '7.1': 8 };
const sourceCounts = { '7.1': 8, '7.1(wide)': 8, '7.1(wide-side)': 8, '6.1': 7, '6.1(back)': 7, '6.1(front)': 7, '5.1': 6, '5.1(side)': 6 };

// Speaker installation is distinct from codec/path support. Never infer it from a model name.
function systemAudioPolicy(settings) {
  const owner = settings.layoutPolicy || 'legacy';
  const speakers = settings.speakerLayout || 'unknown';
  if (owner === 'receiver') return { allowDownmix: false, downmixRules: [], preserve: true,
    explanation: `Playback system manages speaker layout (${speakers}); Audiority does not downmix. Supported originals are preferred. Codec/path limits still apply; receiver calibration is not baked into the file.` };
  if (owner === 'fixed') return { allowDownmix: true, preserve: true,
    downmixRules: Object.entries(sourceCounts).filter(([, count]) => count > speakerCounts[speakers]).map(([source]) => ({ source, target: speakers })),
    explanation: `Fixed-layout compatibility output for ${speakers}; larger approved layouts are combined, smaller sources are not upmixed. Excluded or explicitly kept tracks can remain in other layouts. Retention may add originals alongside compatibility tracks; inspect the verified report for actual output/default flags. Reference matrix unless optional processing is enabled. Bass management, delays and room EQ remain with the playback system.` };
  return { allowDownmix: settings.allowDownmix, downmixRules: settings.downmixRules, preserve: settings.preserve,
    explanation: 'Existing explicit layout rules apply; installed speakers are informational until a system-aware layout policy is selected.' };
}

module.exports = { systemAudioPolicy, speakerCounts };