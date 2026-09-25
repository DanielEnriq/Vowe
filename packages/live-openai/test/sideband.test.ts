import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import { OpenAiLiveTransport } from '../src/openai-live-transport.js';

type FakeSdk = EventEmitter & { socket: EventEmitter & { readyState: number }; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
const fake = vi.hoisted(() => ({ current: null as FakeSdk | null }));
vi.mock('openai/resources/live/sideband/ws', () => ({
  SidebandWS: class {
    constructor() { return fake.current!; }
  },
}));
afterEach(() => { vi.useRealTimers(); });
function harness() {
  const socket = Object.assign(new EventEmitter(), { readyState: 0 });
  const sdk = Object.assign(new EventEmitter(), { socket,
    send: vi.fn(), close: vi.fn(() => { socket.readyState = 3; socket.emit('close'); }) });
  fake.current = sdk;
  const transport = new OpenAiLiveTransport({ client: {} as OpenAI });
  return { socket, sdk, transport };
}

describe('Live sideband attachment', () => {
  it('does not claim attachment until the actual socket opens, and reports later loss', async () => {
    const { transport, socket, sdk } = harness();
    let attached = false;
    const pending = transport.attachSideband('call').then((value) => { attached = true; return value; });
    await vi.waitFor(() => expect(socket.listenerCount('open')).toBe(1));
    expect(attached).toBe(false);
    socket.readyState = 1;
    socket.emit('open');
    const sideband = await pending;
    expect(sideband).not.toBeNull();
    const events: unknown[] = [];
    sideband!.on((event) => events.push(event));
    sdk.emit('close', 1006, 'connection lost', []);
    expect(events).toEqual([{ type: 'session.closed', reason: 'connection lost' }]);
  });

  it('closes and returns unavailable if the handshake fails', async () => {
    const { transport, socket, sdk } = harness();
    const pending = transport.attachSideband('call');
    await vi.waitFor(() => expect(socket.listenerCount('open')).toBe(1));
    socket.emit('error', new Error('denied'));
    expect(await pending).toBeNull();
    expect(sdk.close).toHaveBeenCalledOnce();
    expect(socket.listenerCount('open')).toBe(0);
  });

  it('refuses a socket that closes before opening', async () => {
    const { transport, socket, sdk } = harness();
    const pending = transport.attachSideband('call');
    await vi.waitFor(() => expect(socket.listenerCount('open')).toBe(1));
    // The transport must not attach after the underlying connection has ended.
    socket.readyState = 3;
    socket.emit('close');
    expect(await pending).toBeNull();
    expect(sdk.close).toHaveBeenCalledOnce();
  });
  it('bounds a stalled handshake', async () => {
    vi.useFakeTimers();
    const { transport, socket, sdk } = harness();
    const pending = transport.attachSideband('call');
    await vi.waitFor(() => expect(socket.listenerCount('open')).toBe(1));
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toBeNull();
    expect(sdk.close).toHaveBeenCalledOnce();
  });

});
