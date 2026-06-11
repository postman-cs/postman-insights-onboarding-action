#!/usr/bin/env node
// Renders the README Inputs/Outputs tables from action.yml between marker comments.
// Usage:
//   node scripts/render-action-tables.mjs --write   rewrite README.md in place
//   node scripts/render-action-tables.mjs --check   exit 1 if README tables are stale
import console from 'node:console';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const actionPath = resolve(repoRoot, 'action.yml');
const readmePath = resolve(repoRoot, 'README.md');

// postman-stack is an internal stack-profile escape hatch; the action contract
// keeps it out of the README on purpose (see tests/contract.test.ts).
const HIDDEN_INPUTS = new Set(['postman-stack']);

const manifest = parse(readFileSync(actionPath, 'utf8'));

function escapeCell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

export function renderInputsTable(inputs) {
  const rows = Object.entries(inputs)
    .filter(([name]) => !HIDDEN_INPUTS.has(name))
    .map(([name, spec]) => {
      const required = spec.required === true ? 'Yes' : 'No';
      const def = spec.default !== undefined && spec.default !== '' ? `\`${spec.default}\`` : '';
      return `| \`${name}\` | ${escapeCell(spec.description)} | ${required} | ${def} |`;
    });
  return [
    '| Name | Description | Required | Default |',
    '| --- | --- | --- | --- |',
    ...rows
  ].join('\n');
}

export function renderOutputsTable(outputs) {
  const rows = Object.entries(outputs).map(
    ([name, spec]) => `| \`${name}\` | ${escapeCell(spec.description)} |  |  |`
  );
  return [
    '| Name | Description | Required | Default |',
    '| --- | --- | --- | --- |',
    ...rows
  ].join('\n');
}

function replaceBetween(content, startMarker, endMarker, table) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README.md is missing markers ${startMarker} / ${endMarker}`);
  }
  return (
    content.slice(0, start + startMarker.length) +
    '\n' +
    table +
    '\n' +
    content.slice(end)
  );
}

export function renderReadme(readme) {
  let next = replaceBetween(
    readme,
    '<!-- inputs-table:start -->',
    '<!-- inputs-table:end -->',
    renderInputsTable(manifest.inputs)
  );
  next = replaceBetween(
    next,
    '<!-- outputs-table:start -->',
    '<!-- outputs-table:end -->',
    renderOutputsTable(manifest.outputs)
  );
  return next;
}

const mode = process.argv[2] ?? '--check';
const current = readFileSync(readmePath, 'utf8');
const next = renderReadme(current);

if (mode === '--write') {
  if (next !== current) {
    writeFileSync(readmePath, next);
    console.log('README.md tables updated from action.yml');
  } else {
    console.log('README.md tables already current');
  }
} else if (mode === '--check') {
  if (next !== current) {
    console.error('README.md tables are stale. Run: npm run docs:tables');
    process.exit(1);
  }
  console.log('README.md tables match action.yml');
} else {
  console.error(`Unknown mode: ${mode} (use --write or --check)`);
  process.exit(2);
}
