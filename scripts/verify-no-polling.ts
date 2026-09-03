import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { ResetRequestPaths } from '../src/reset/config/paths.js';
import { renderLaunchAgent } from '../src/reset/service/launchd.js';
import { renderSystemdUnit } from '../src/reset/service/systemd.js';

interface Finding {
  file: string;
  line: number;
  code: string;
}

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const excludedRepositoryDirectories = new Set(['.git', '.tmp', 'coverage', 'dist', 'node_modules', '.pnpm-store']);
const productionScriptExtensions = new Set(['.cjs', '.js', '.mjs', '.ts', '.tsx']);

function relativePath(filePath: string): string {
  return path.relative(repositoryRoot, filePath).split(path.sep).join('/');
}

async function productionFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await productionFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

async function repositoryFiles(directory = repositoryRoot): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excludedRepositoryDirectories.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await repositoryFiles(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files.sort();
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function callName(expression: ts.LeftHandSideExpression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function propertyNameText(name: ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return null;
}

function assignedPropertyName(expression: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    return ts.isStringLiteralLike(expression.argumentExpression) ? expression.argumentExpression.text : null;
  }
  return null;
}

interface BooleanBinding {
  value: boolean | null;
}

function literalBoolean(expression: ts.Expression | undefined): boolean | null {
  if (!expression) return null;
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return literalBoolean(expression.expression);
  }
  return null;
}

function declarationListBinding(
  declarations: ts.VariableDeclarationList,
  name: string,
): BooleanBinding | undefined {
  for (const declaration of declarations.declarations) {
    if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
    const isConst = (declarations.flags & ts.NodeFlags.Const) !== 0;
    return { value: isConst ? literalBoolean(declaration.initializer) : null };
  }
  return undefined;
}

function statementListBinding(statements: readonly ts.Statement[], name: string): BooleanBinding | undefined {
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      const binding = declarationListBinding(statement.declarationList, name);
      if (binding) return binding;
    }
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return { value: null };
    }
  }
  return undefined;
}

function lexicalBooleanBinding(identifier: ts.Identifier): boolean | null {
  const name = identifier.text;
  for (let ancestor: ts.Node | undefined = identifier.parent; ancestor; ancestor = ancestor.parent) {
    let binding: BooleanBinding | undefined;
    if (ts.isBlock(ancestor) || ts.isSourceFile(ancestor) || ts.isModuleBlock(ancestor)) {
      binding = statementListBinding(ancestor.statements, name);
    } else if (ts.isCaseBlock(ancestor)) {
      binding = statementListBinding(
        ancestor.clauses.flatMap((clause) => [...clause.statements]),
        name,
      );
    } else if (ts.isFunctionLike(ancestor)) {
      const parameter = ancestor.parameters.find(
        (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
      );
      if (parameter) binding = { value: literalBoolean(parameter.initializer) };
    } else if (ts.isForStatement(ancestor) && ancestor.initializer && ts.isVariableDeclarationList(ancestor.initializer)) {
      binding = declarationListBinding(ancestor.initializer, name);
    } else if (
      (ts.isForInStatement(ancestor) || ts.isForOfStatement(ancestor)) &&
      ts.isVariableDeclarationList(ancestor.initializer)
    ) {
      binding = declarationListBinding(ancestor.initializer, name);
    } else if (ts.isCatchClause(ancestor)) {
      const catchName = ancestor.variableDeclaration?.name;
      if (catchName && ts.isIdentifier(catchName) && catchName.text === name) binding = { value: null };
    }
    if (binding) return binding.value;
  }
  return null;
}

function isProvablyTrue(expression: ts.Expression): boolean {
  const literal = literalBoolean(expression);
  if (literal !== null) return literal;
  return ts.isIdentifier(expression) && lexicalBooleanBinding(expression) === true;
}

function loopContainsWait(loop: ts.IterationStatement): boolean {
  let containsAwait = false;
  let containsWaitCall = false;
  const inspect = (node: ts.Node) => {
    if (node !== loop && ts.isFunctionLike(node)) return;
    if (ts.isAwaitExpression(node)) containsAwait = true;
    if (ts.isCallExpression(node) && ['setTimeout', 'sleep'].includes(callName(node.expression) ?? '')) {
      containsWaitCall = true;
    }
    ts.forEachChild(node, inspect);
  };
  ts.forEachChild(loop, inspect);
  return containsAwait && containsWaitCall;
}

export function inspectProductionSource(
  filePath: string,
  value: string,
): { findings: Finding[]; rateLimitReads: number[] } {
  const file = relativePath(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const scriptKind = extension === '.tsx' ? ts.ScriptKind.TSX : extension === '.ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, value, ts.ScriptTarget.Latest, true, scriptKind);
  const findings: Finding[] = [];
  const rateLimitReads: number[] = [];
  const add = (node: ts.Node, code: string) => findings.push({ file, line: lineOf(source, node), code });

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      if (node.text === 'setInterval') add(node, 'periodic-interval-reference');
      if (node.text === 'watchFile') add(node, 'filesystem-polling-reference');
      if (node.text === 'cron' || node.text === 'crontab') add(node, 'cron-runtime-reference');
    }
    if (
      ts.isPropertyAssignment(node) &&
      propertyNameText(node.name) === 'usePolling' &&
      isProvablyTrue(node.initializer)
    ) {
      add(node, 'polling-option-enabled');
    }
    if (
      ts.isShorthandPropertyAssignment(node) &&
      node.name.text === 'usePolling' &&
      lexicalBooleanBinding(node.name) === true
    ) {
      add(node, 'polling-option-enabled');
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      assignedPropertyName(node.left) === 'usePolling' &&
      isProvablyTrue(node.right)
    ) {
      add(node, 'polling-option-enabled');
    }
    if (file.startsWith('src/reset/') && ts.isIterationStatement(node, false) && loopContainsWait(node)) {
      add(node, 'timeout-or-sleep-loop');
    }
    if (ts.isStringLiteralLike(node)) {
      if (node.text === 'setInterval') add(node, 'periodic-interval-reference');
      if (node.text === 'watchFile') add(node, 'filesystem-polling-reference');
      const literalRules: Array<[RegExp, string]> = [
        [/StartInterval/i, 'launchd-start-interval'],
        [/CalendarInterval/i, 'launchd-calendar-interval'],
        [/OnCalendar\s*=/i, 'systemd-calendar-trigger'],
        [/OnUnitActiveSec\s*=/i, 'systemd-active-timer'],
        [/\bcron(?:tab)?\b/i, 'cron-runtime-string'],
      ];
      for (const [pattern, code] of literalRules) {
        if (pattern.test(node.text)) add(node, code);
      }
      if (node.text === 'account/rateLimits/read') rateLimitReads.push(lineOf(source, node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { findings, rateLimitReads };
}

function isServiceArtifact(filePath: string): boolean {
  const file = relativePath(filePath);
  const basename = path.posix.basename(file).toLowerCase();
  const extension = path.posix.extname(basename);
  return extension === '.plist' || extension === '.service' || extension === '.timer' || /(?:^|[._-])cron(?:tab)?(?:[._-]|$)/i.test(basename);
}

async function inspectServiceArtifacts(): Promise<Finding[]> {
  const findings: Finding[] = [];
  const rules: Array<[RegExp, string]> = [
    [/StartInterval/i, 'service-launchd-start-interval'],
    [/CalendarInterval/i, 'service-launchd-calendar-interval'],
    [/OnCalendar\s*=/i, 'service-systemd-calendar-trigger'],
    [/OnUnitActiveSec\s*=/i, 'service-systemd-active-timer'],
    [/\bcron(?:tab)?\b/i, 'service-cron-reference'],
  ];
  for (const filePath of await repositoryFiles()) {
    if (!isServiceArtifact(filePath)) continue;
    const file = relativePath(filePath);
    if (file.toLowerCase().endsWith('.timer')) {
      findings.push({ file, line: 1, code: 'systemd-timer-file' });
    }
    const lines = (await readFile(filePath, 'utf8')).split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const [pattern, code] of rules) {
        if (pattern.test(line)) findings.push({ file, line: index + 1, code });
      }
    }
  }
  return findings;
}

async function inspectWorkflows(): Promise<Finding[]> {
  const workflowsDirectory = path.join(repositoryRoot, '.github', 'workflows');
  let entries: Dirent[];
  try {
    entries = await readdir(workflowsDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rules: Array<[RegExp, string]> = [
    [/^\s*pull_request_target\s*:/, 'privileged-pull-request-workflow'],
    [/^\s*schedule\s*:/, 'scheduled-workflow'],
    [/^\s*cron\s*:/, 'cron-workflow'],
    [/CRR_LIVE_X\s*:\s*['"]?1\b/, 'live-x-gate-in-ci'],
    [/BIRD_LIVE\s*:\s*['"]?1\b/, 'legacy-live-gate-in-ci'],
    [/(?:codex-reset-request|cli\.js)\s+test\s+x-(?:read|reply)\b/, 'live-x-command-in-ci'],
  ];
  const findings: Finding[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const filePath = path.join(workflowsDirectory, entry.name);
    const lines = (await readFile(filePath, 'utf8')).split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const [pattern, code] of rules) {
        if (pattern.test(line)) findings.push({ file: relativePath(filePath), line: index + 1, code });
      }
    }
  }
  return findings;
}

function inspectRenderedServices(): Finding[] {
  const paths: ResetRequestPaths = {
    configDir: '/home/example/.config/codex-reset-request',
    stateDir: '/home/example/.local/state/codex-reset-request',
    logDir: '/home/example/.local/state/codex-reset-request/logs',
    configFile: '/home/example/.config/codex-reset-request/config.json',
    stateFile: '/home/example/.local/state/codex-reset-request/state.json',
    cursorFile: '/home/example/.local/state/codex-reset-request/cursors.json',
    auditLogFile: '/home/example/.local/state/codex-reset-request/logs/audit.jsonl',
    daemonLockFile: '/home/example/.local/state/codex-reset-request/watcher.lock',
  };
  const definitions = [
    renderLaunchAgent({
      nodePath: '/usr/local/bin/node',
      cliPath: '/home/example/codex-reset-request/dist/reset/cli.js',
      codexHome: '/home/example/.codex',
      paths,
      environmentPath: '/usr/local/bin:/usr/bin:/bin',
    }),
    renderSystemdUnit({
      nodePath: '/usr/local/bin/node',
      cliPath: '/home/example/codex-reset-request/dist/reset/cli.js',
      codexHome: '/home/example/.codex',
      paths,
      environmentPath: '/usr/local/bin:/usr/bin:/bin',
    }),
  ];
  const forbidden: Array<[RegExp, string]> = [
    [/StartInterval/i, 'rendered-launchd-start-interval'],
    [/CalendarInterval/i, 'rendered-launchd-calendar-interval'],
    [/OnCalendar\s*=/i, 'rendered-systemd-calendar-trigger'],
    [/OnUnitActiveSec\s*=/i, 'rendered-systemd-active-timer'],
    [/\.timer\b/i, 'rendered-systemd-timer-unit'],
    [/\bcron(?:tab)?\b/i, 'rendered-cron-reference'],
  ];
  const findings: Finding[] = [];
  for (const [definitionIndex, definition] of definitions.entries()) {
    for (const [lineIndex, line] of definition.split(/\r?\n/).entries()) {
      for (const [pattern, code] of forbidden) {
        if (pattern.test(line)) {
          findings.push({ file: `rendered-service-${definitionIndex + 1}`, line: lineIndex + 1, code });
        }
      }
    }
  }
  return findings;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    console.error('usage: pnpm run verify:no-polling');
    process.exitCode = 2;
    return;
  }

  const findings: Finding[] = [];
  const rateLimitReadLocations: Array<{ file: string; line: number }> = [];
  for (const filePath of await productionFiles(path.join(repositoryRoot, 'src'))) {
    if (!productionScriptExtensions.has(path.extname(filePath).toLowerCase())) continue;
    const inspected = inspectProductionSource(filePath, await readFile(filePath, 'utf8'));
    findings.push(...inspected.findings);
    for (const line of inspected.rateLimitReads) rateLimitReadLocations.push({ file: relativePath(filePath), line });
  }
  findings.push(...(await inspectServiceArtifacts()));
  const expectedRead = rateLimitReadLocations.filter(
    ({ file }) => file === 'src/reset/codex/app-server-client.ts',
  );
  if (rateLimitReadLocations.length !== 1 || expectedRead.length !== 1) {
    findings.push({ file: 'src/reset/codex/app-server-client.ts', line: 1, code: 'rate-limit-read-callsite-drift' });
  }
  findings.push(...(await inspectWorkflows()));
  findings.push(...inspectRenderedServices());

  const unique = [...new Map(findings.map((finding) => [`${finding.file}:${finding.line}:${finding.code}`, finding])).values()]
    .sort((left, right) =>
      `${left.file}:${left.line.toString().padStart(8, '0')}:${left.code}`.localeCompare(
        `${right.file}:${right.line.toString().padStart(8, '0')}:${right.code}`,
      ),
    );
  if (unique.length > 0) {
    for (const finding of unique) console.error(`${finding.file}:${finding.line}:${finding.code}`);
    process.exitCode = 1;
    return;
  }
  console.log('verify-no-polling: ok');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
