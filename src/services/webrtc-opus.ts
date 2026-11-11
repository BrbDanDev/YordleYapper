/** Set speech-friendly Opus defaults without assuming a payload type. */
export function tuneOpusSdp(sdp: string): string {
  const lines = sdp.split(/\r?\n/);
  const opusPayloads = new Set<string>();
  for (const line of lines) {
    const match = /^a=rtpmap:(\d+)\s+opus\/48000(?:\/2)?\s*$/i.exec(line);
    if (match) opusPayloads.add(match[1]);
  }
  for (const payload of opusPayloads) {
    const fmtpPrefix = `a=fmtp:${payload} `;
    const fmtpIndex = lines.findIndex(line => line.startsWith(fmtpPrefix));
    const params = new Map<string, string>();
    if (fmtpIndex >= 0) {
      for (const item of lines[fmtpIndex].slice(fmtpPrefix.length).split(';')) {
        const [key, ...value] = item.trim().split('=');
        if (key) params.set(key.toLowerCase(), value.join('='));
      }
    }
    // Full-mesh clients each upload one copy per peer. A speech bitrate keeps
    // several simultaneous sends viable, while FEC helps reconstruct packets
    // lost on weak uplinks. Keep DTX disabled: this app's prior tests found it
    // could clip the first syllable as speech resumed after silence.
    params.set('maxaveragebitrate', '48000');
    params.set('usedtx', '0');
    params.set('useinbandfec', '1');
    const tuned = fmtpPrefix + [...params].map(([key, value]) => `${key}=${value}`).join(';');
    if (fmtpIndex >= 0) lines[fmtpIndex] = tuned;
    else {
      const rtpmapIndex = lines.findIndex(line => line.startsWith(`a=rtpmap:${payload} `));
      if (rtpmapIndex >= 0) lines.splice(rtpmapIndex + 1, 0, tuned);
    }
  }
  return lines.join('\r\n');
}
