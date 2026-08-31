import { describe, expect, it } from 'vitest';

import { BridgeEndpoint, ErrorCode, SessionHost } from '../src/index.js';
import { createPipe, flush } from './helpers/pipe.js';

describe('SessionHost', () => {
  it('exposes a snapshot of live sessions', async () => {
    const pipe = createPipe();
    const host = new SessionHost();
    void host.accept(pipe.server);
    const client = new BridgeEndpoint({ role: 'client' });
    await client.attach(pipe.client);

    const sessionId = client.sessionId as string;
    expect([...host.sessions.keys()]).toEqual([sessionId]);
    expect(host.sessions.get(sessionId)).toBe(host.get(sessionId));

    host.close();
    expect(host.sessions.size).toBe(0);
    expect(host.get(sessionId)?.state ?? 'closed').toBe('closed');
  });

  it('rejects a connection whose first bytes are not a valid frame', async () => {
    const pipe = createPipe();
    const host = new SessionHost();
    const accepted = host.accept(pipe.server);
    pipe.client.send(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]));
    await expect(accepted).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_VERSION });
  });

  it('rejects a connection that dies before it identifies itself', async () => {
    const pipe = createPipe();
    const host = new SessionHost();
    const accepted = host.accept(pipe.server);
    pipe.break();
    await expect(accepted).rejects.toThrow(/closed during handshake/);
  });

  it('mints session identifiers through the injected factory', async () => {
    let counter = 0;
    const pipe = createPipe();
    const host = new SessionHost({
      createSessionId: () => `session-${String((counter += 1))}`,
    });
    void host.accept(pipe.server);
    const client = new BridgeEndpoint({ role: 'client', clientName: 'test/1.0' });
    await client.attach(pipe.client);
    await flush();
    expect(client.sessionId).toBe('session-1');
    expect(host.get('session-1')).toBeDefined();
  });
});
