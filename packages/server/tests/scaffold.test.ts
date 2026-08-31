import { describe, expect, it } from 'vitest';

import * as pkg from '../src/index.js';

describe('server scaffold', () => {
  it('module loads', () => {
    expect(pkg).toBeTypeOf('object');
  });
});
