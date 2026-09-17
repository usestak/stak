import type { ScanResult, SkillRootKind } from '@stack/spec';

const labels: Record<SkillRootKind, string> = {
  agents: 'Shared',
  cursor: 'Cursor',
  codex: 'Codex',
  claude: 'Claude',
};

export const renderScanResult = (result: ScanResult): string => {
  const lines = ['Scanning your agent Skills...', ''];
  for (const root of result.roots) {
    const marker =
      root.status === 'scanned' ? '✓' : root.status === 'missing' ? '○' : '✗';
    const suffix =
      root.status === 'missing'
        ? '  not found'
        : root.status === 'failed'
          ? `  failed: ${root.error ?? 'unknown error'}`
          : '';
    lines.push(
      `${marker} ${labels[root.rootKind]} (${root.scope})  ${root.path}${suffix}`,
    );
  }
  lines.push(
    '',
    `Found ${result.summary.uniqueSkillContents} unique Skill contents across ${result.summary.locations} locations.`,
    '',
    `${result.summary.validSkills} valid`,
    `${result.summary.invalidSkills} invalid`,
    `${result.summary.diagnostics.warnings} warnings`,
    '',
    'Roots',
  );
  for (const root of result.roots)
    lines.push(
      `${labels[root.rootKind]} (${root.scope})  ${root.skillLocations}`,
    );
  lines.push(
    '',
    `Exact duplicates  ${result.summary.exactDuplicateContents}`,
    `Name collisions  ${result.summary.nameCollisions}`,
    '',
    'Provenance',
    `Git-backed  ${result.summary.provenance.git}`,
    `Local       ${result.summary.provenance.local}`,
    `Unknown     ${result.summary.provenance.unknown}`,
  );
  if (result.diagnostics.length > 0) {
    lines.push('', 'Diagnostics');
    for (const diagnostic of result.diagnostics) {
      lines.push(
        `${diagnostic.severity.toUpperCase()} ${diagnostic.message}${diagnostic.path ? `\n  ${diagnostic.path}` : ''}`,
      );
    }
  }
  lines.push('', 'No changes were made.', '');
  return lines.join('\n');
};
