import { describe, expect, it } from 'vitest';
import {
  agentOfAgentsPath,
  namespaceOf,
  validateCanonicalPath,
} from './paths.js';

describe('validateCanonicalPath', () => {
  it('accepts a normal notes path', () => {
    expect(validateCanonicalPath('notes/auth-decisions.md')).toBe(
      'notes/auth-decisions.md',
    );
  });

  it('rejects a path outside the three namespaces', () => {
    expect(() => validateCanonicalPath('random/file.md')).toThrow();
  });

  it('rejects traversal', () => {
    expect(() => validateCanonicalPath('notes/../secret.md')).toThrow();
  });

  it('rejects backslashes and absolute paths', () => {
    expect(() => validateCanonicalPath('notes\\x.md')).toThrow();
    expect(() => validateCanonicalPath('/notes/x.md')).toThrow();
    expect(() => validateCanonicalPath('C:/notes/x.md')).toThrow();
  });

  it('rejects a bare namespace with no file', () => {
    expect(() => validateCanonicalPath('notes')).toThrow();
    expect(() => validateCanonicalPath('notes/')).toThrow();
  });

  it('normalizes to NFC', () => {
    const nfd = 'notes/cafe\u0301.md';
    expect(validateCanonicalPath(nfd)).toBe('notes/caf\u00e9.md');
  });
});

describe('namespaceOf', () => {
  it('identifies each namespace', () => {
    expect(namespaceOf('notes/x.md')).toBe('notes');
    expect(namespaceOf('instructions/private.md')).toBe('instructions');
    expect(namespaceOf('agents/reviewer/x.md')).toBe('agents');
  });

  it('returns null for an unrecognized namespace', () => {
    expect(namespaceOf('other/x.md')).toBeNull();
  });
});

describe('agentOfAgentsPath', () => {
  it('extracts the agent name', () => {
    expect(agentOfAgentsPath('agents/reviewer/notes.md')).toBe('reviewer');
  });

  it('returns null outside agents namespace', () => {
    expect(agentOfAgentsPath('notes/x.md')).toBeNull();
  });
});
