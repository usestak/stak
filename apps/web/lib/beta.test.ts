import { describe, expect, it } from 'vitest';

import {
  PUBLIC_BETA_INSTALL_COMMAND,
  PUBLIC_BETA_LABEL,
  PUBLIC_BETA_VERSION,
} from './beta';

describe('beta constants', () => {
  it('pins the public beta install command to the @beta dist-tag', () => {
    expect(PUBLIC_BETA_INSTALL_COMMAND).toBe('npm install -g @memstk/cli@beta');
  });

  it('pins the surfaced version string', () => {
    expect(PUBLIC_BETA_VERSION).toBe('v0.2.0-beta.3');
  });

  it('pins the label used across the nav pill and /beta page', () => {
    expect(PUBLIC_BETA_LABEL).toBe('Public Beta');
  });
});
