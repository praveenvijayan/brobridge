import { describe, expect, it } from 'vitest';

import * as pkg from '../src/index.js';

describe('client scaffold', () => {
  it('module loads', () => {
    expect(pkg).toBeTypeOf('object');
  });
});
