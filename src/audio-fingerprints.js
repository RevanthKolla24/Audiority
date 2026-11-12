const crypto = require('node:crypto');

// Compact FFprobe packet records contain numeric indices and SHA-256 hex only.
// Do not accept partial hashes or silently turn malformed scans into empty hashes.
function audioFingerprints(indices) {
  const streams = new Map(indices.map(index => [index, { hash: crypto.createHash('sha256'), count: 0 }]));
  return {
    packet(line) {
      if (!line.trim()) return false;
      const index = line.match(/(?:^|\|)stream_index=(\d+)(?:\||$)/);
      if (!index) throw new Error('Verification failed: missing audio packet stream index.');
      const stream = streams.get(Number(index[1]));
      if (!stream) return false;
      const digest = line.match(/(?:^|\|)data_hash=(SHA256:[a-fA-F0-9]{64})(?:\||$)/);
      if (!digest) throw new Error('Verification failed: missing or malformed copied audio packet hash.');
      stream.hash.update(`${digest[1]}\n`); stream.count++;
      return true;
    },
    finish() {
      return indices.map(index => {
        const stream = streams.get(index);
        if (!stream.count) throw new Error(`Verification failed: copied audio stream ${index} has no verifiable packets.`);
        return { count: stream.count, hash: stream.hash.digest('hex') };
      });
    }
  };
}

module.exports = { audioFingerprints };