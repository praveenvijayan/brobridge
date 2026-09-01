import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from '../src/index.js';

describe('@brobridgejs/core scaffold', () => {
  it('exposes the wire protocol version defined by PROTOCOL.md', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
