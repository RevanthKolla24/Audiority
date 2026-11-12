// Shared by command construction and reporting, so reports describe applied filters.
function audioFilters(track, preferences = {}, profile) {
  if (track.action !== 'encode') return [];
  const filters = [];
  if (track.downmix) {
    if (track.sourceLayout === '6.1(front)' && track.layout !== 'stereo') {
      throw new Error('6.1(front) has no discrete center; conversion to a center-equipped layout is not supported.');
    }
    filters.push(`aresample=out_chlayout=${track.layout}:rematrix_maxval=1:lfe_mix_level=0`);
  }
  if (track.downmix && track.sourceLayout?.startsWith('7.1') && ['5.1', '5.1(side)'].includes(track.layout) &&
      (preferences.dialogueBoost || profile?.dialogueBoost || profile?.settings?.dialogueBoost)) {
    const surround = track.layout === '5.1(side)' ? ['SL', 'SR'] : ['BL', 'BR'];
    filters.push(`pan=${track.layout}|FL=FL|FR=FR|FC=1.5*FC|LFE=LFE|${surround[0]}=${surround[0]}|${surround[1]}=${surround[1]}`);
  }
  if (preferences.normalizeVolume || profile?.settings?.normalizeVolume) filters.push('dynaudnorm=f=150:g=15');
  return filters;
}

module.exports = { audioFilters };