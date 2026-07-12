import { describe, expect, test } from 'bun:test';

import { listCatalogLenses, readReference } from '../extensions/code-reviewer/catalog';

describe('listCatalogLenses', () => {
  test('enumerates the vendored lens catalog with id, description, and path', () => {
    const lenses = listCatalogLenses();
    const ids = lenses.map((l) => l.id);
    // The canonical catalog ships these five lenses.
    expect(ids).toContain('security');
    expect(ids).toContain('clean-code');

    const security = lenses.find((l) => l.id === 'security')!;
    expect(security.description.length).toBeGreaterThan(0);
    expect(security.path).toContain('skills/code-reviewer/lenses/security.md');
  });
});

describe('readReference', () => {
  test('reads a vendored reference doc body', () => {
    expect(readReference('init.md')).toContain('init');
    expect(readReference('CONTEXT-TEMPLATE.md')).toContain('Critical invariants');
  });

  test('returns empty string for a missing reference', () => {
    expect(readReference('does-not-exist.md')).toBe('');
  });
});
