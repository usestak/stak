import { validateTreePath } from '@stack/shared';

export const NAMESPACES = ['notes', 'instructions', 'agents'] as const;
export type Namespace = (typeof NAMESPACES)[number];

export class InvalidCanonicalPathError extends Error {
  constructor(public readonly path: string) {
    super(`Invalid canonical Memory path: ${path}`);
    this.name = 'InvalidCanonicalPathError';
  }
}

export const validateCanonicalPath = (path: string): string => {
  if (path.includes('\\')) {
    throw new InvalidCanonicalPathError(path);
  }
  const nfc = path.normalize('NFC');
  let normalized: string;
  try {
    normalized = validateTreePath(nfc);
  } catch {
    throw new InvalidCanonicalPathError(path);
  }
  const segments = normalized.split('/');
  const namespace = segments[0];
  const rest = segments.slice(1);
  if (
    !namespace ||
    !(NAMESPACES as readonly string[]).includes(namespace) ||
    rest.length === 0 ||
    rest.some((segment) => segment.length === 0)
  )
    throw new InvalidCanonicalPathError(path);
  return normalized;
};

export const namespaceOf = (path: string): Namespace | null => {
  const first = path.split('/')[0];
  return (NAMESPACES as readonly string[]).includes(first ?? '')
    ? (first as Namespace)
    : null;
};

export const agentOfAgentsPath = (path: string): string | null => {
  if (namespaceOf(path) !== 'agents') return null;
  const agent = path.split('/')[1];
  return agent && agent.length > 0 ? agent : null;
};
