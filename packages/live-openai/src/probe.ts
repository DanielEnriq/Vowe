/**
 * Check the live transport against the real provider, without a microphone.
 *
 *   OPENAI_API_KEY=... pnpm --filter @vowe/live-openai run probe
 *
 * The unit tests cover this transport against a fake provider, which proves the
 * bridge's logic but can never tell you whether the provider accepts the session
 * config we actually send, or whether the sideband attaches. This does, using a
 * hand-built SDP offer instead of a browser.
 *
 * Reading the result:
 *
 *   401                      the key is wrong
 *   400 "failed to ... SDP"  the session config was ACCEPTED; only the offer
 *                            was rejected, which is expected from a synthetic one
 *   400 about `session`      our session config is wrong — fix the transport
 *   429 no credits           everything is correct; the account needs funding
 *   a session id             the config and the offer both went through, and the
 *                            sideband check below is meaningful
 */
import { OpenAiLiveTransport } from './openai-live-transport.ts';

/**
 * A syntactically valid minimal audio offer. It will not carry media, but if the
 * provider can unmarshal it and return a session id, the sideband path becomes
 * testable without a browser.
 */
const MINIMAL_OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=msid-semantic: WMS',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP4 0.0.0.0',
  'a=rtcp:9 IN IP4 0.0.0.0',
  'a=ice-ufrag:probe',
  'a=ice-pwd:probepassword0123456789abcd',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 8F:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8:09:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8',
  'a=setup:actpass',
  'a=mid:0',
  'a=sendrecv',
  'a=rtcp-mux',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  '',
].join('\r\n');

const transport = new OpenAiLiveTransport({
  onError: (scope, error) => console.log(`  [onError] ${scope}:`, String(error).slice(0, 300)),
});

console.log('available:', transport.available);
console.log('unavailableReason:', transport.unavailableReason);

console.log('\n--- 1. does the provider accept our session config? ---');
try {
  const created = await transport.createSession({
    sdpOffer: MINIMAL_OFFER,
    instructions: 'You are Vo, a test.',
  });
  console.log('  session created:', created.liveSessionId);
  console.log('\n--- 2. does the sideband attach? ---');
  const sideband = await transport.attachSideband(created.liveSessionId);
  console.log('  attached:', sideband !== null);
  if (sideband) {
    await sideband.appendThinking('A probe, verifying the append path.');
    console.log('  appendThinking sent');
    await new Promise((r) => setTimeout(r, 2500));
    await sideband.close();
  }
} catch (error) {
  const err = error as { status?: number; message?: string };
  console.log('  status:', err.status);
  console.log('  message:', (err.message ?? String(error)).slice(0, 700));
}
