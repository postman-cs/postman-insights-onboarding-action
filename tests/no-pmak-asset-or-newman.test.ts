import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ACTION_ROOT = resolve(import.meta.dirname, '..');
const SRC_ROOT = join(ACTION_ROOT, 'src');

type PatternId = 'newman' | 'pmak-header' | 'pmak-cli-login';

/**
 * Sanctioned PMAK / Postman-CLI sites. PMAK survives ONLY for:
 * Insights PMAK use is limited to human-user GET /me validation and the two
 * observability application-binding methods. Bifrost and Akita use the user token.
 */
const ALLOWLIST: Record<string, PatternId[]> = {
  'src/index.ts': ['pmak-header'],
  'src/lib/credential-identity.ts': ['pmak-header'],
  'src/lib/bifrost-client.ts': ['pmak-header']
};

type Violation = { file: string; line: number; pattern: PatternId; text: string };

function walkTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      return walkTypeScriptFiles(abs);
    }
    return abs.endsWith('.ts') ? [abs] : [];
  });
}

/** Remove // and block comments without touching string/template contents. */
function stripComments(source: string): string {
  let result = '';
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      result += '\n';
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        i += 1;
      }
      i += 2;
      result += '\n';
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      result += ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          result += source[i] + source[i + 1];
          i += 2;
          continue;
        }
        if (source[i] === ch) {
          result += source[i];
          i += 1;
          break;
        }
        result += source[i];
        i += 1;
      }
      continue;
    }

    result += ch;
    i += 1;
  }

  return result;
}

function matchPatterns(line: string): PatternId[] {
  const hits: PatternId[] = [];
  if (/['"]newman['"]|\bnewman\s+run\b|\bnewman\s*\.\s*run\b/i.test(line)) {
    hits.push('newman');
  }
  if (/['"]x-api-key['"]\s*:/i.test(line)) {
    hits.push('pmak-header');
  }
  if (/--with-api-key/.test(line)) {
    hits.push('pmak-cli-login');
  }
  return hits;
}

function scanSourceFile(absPath: string): Violation[] {
  const relPath = relative(ACTION_ROOT, absPath).replace(/\\/g, '/');
  const stripped = stripComments(readFileSync(absPath, 'utf8'));
  const hits: Violation[] = [];
  stripped.split('\n').forEach((line, index) => {
    for (const pattern of matchPatterns(line)) {
      hits.push({ file: relPath, line: index + 1, pattern, text: line.trim() });
    }
  });
  return hits;
}

function isSanctioned(v: Violation): boolean {
  // Newman is never allowlisted; x-api-key / --with-api-key only in the sanctioned files.
  return v.pattern !== 'newman' && (ALLOWLIST[v.file]?.includes(v.pattern) ?? false);
}

function format(vs: Violation[]): string {
  return vs.map((v) => `${v.file}:${v.line}: ${v.pattern} — ${v.text}`).join('\n');
}

describe('no PMAK asset op or Newman in production src/', () => {
  const allHits = walkTypeScriptFiles(SRC_ROOT).flatMap(scanSourceFile);

  it('has no un-sanctioned x-api-key / --with-api-key, and no Newman anywhere', () => {
    const violations = allHits.filter((v) => !isSanctioned(v));
    expect(violations, format(violations)).toEqual([]);
  });

  it('has no stale allowlist entries (every sanctioned site still exists)', () => {
    const stale: string[] = [];
    for (const [file, patterns] of Object.entries(ALLOWLIST)) {
      for (const pattern of patterns) {
        if (!allHits.some((v) => v.file === file && v.pattern === pattern)) {
          stale.push(`${file}: ${pattern}`);
        }
      }
    }
    expect(stale, `stale allowlist entries:\n${stale.join('\n')}`).toEqual([]);
  });

  it('declares no Newman dependency in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(ACTION_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const newmanDeps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {})
    ].filter((name) => /(^|[/@-])newman([/-]|$)/i.test(name));
    expect(newmanDeps, `Newman dependencies: ${newmanDeps.join(', ')}`).toEqual([]);
  });

  it('limits PMAK headers to GET /me and observability application binding', () => {
    const indexSource = readFileSync(join(SRC_ROOT, 'index.ts'), 'utf8');
    const bifrostSource = readFileSync(join(SRC_ROOT, 'lib', 'bifrost-client.ts'), 'utf8');
    const pmakHeaders = [...indexSource.matchAll(/['"]x-api-key['"]\s*:/g), ...bifrostSource.matchAll(/['"]x-api-key['"]\s*:/g)];

    expect(indexSource).toContain('`${trimTrailingSlash(apiBase)}/me`');
    expect(bifrostSource).toContain('/v2/agent/api-catalog/workspaces/${workspaceId}/applications');
    expect(pmakHeaders).toHaveLength(3);
    expect(readFileSync(join(SRC_ROOT, 'lib', 'postman', 'token-provider.ts'), 'utf8')).not.toContain('service-account-tokens');
  });
});
