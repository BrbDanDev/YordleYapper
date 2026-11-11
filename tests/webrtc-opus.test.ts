import { tuneOpusSdp } from '../src/services/webrtc-opus';

describe('Opus SDP tuning', () => {
  test('finds dynamic Opus payload types and updates existing parameters', () => {
    const input = [
      'm=audio 9 UDP/TLS/RTP/SAVPF 109 112',
      'a=rtpmap:109 opus/48000/2',
      'a=fmtp:109 minptime=10;useinbandfec=0;usedtx=1;maxaveragebitrate=128000',
      'a=rtpmap:112 telephone-event/8000',
    ].join('\r\n');
    const output = tuneOpusSdp(input);
    expect(output).toContain('a=fmtp:109 minptime=10;useinbandfec=1;usedtx=0;maxaveragebitrate=48000');
    expect(output).not.toContain('fmtp:112');
  });

  test('adds Opus parameters when an SDP has no fmtp line', () => {
    const output = tuneOpusSdp('m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2');
    expect(output).toContain('a=fmtp:111 maxaveragebitrate=48000;usedtx=0;useinbandfec=1');
  });
});
