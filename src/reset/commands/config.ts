import type { Command } from 'commander';
import { loadConfig } from '../config/load.js';
import { saveConfig } from '../config/save.js';
import {
  createDefaultConfig,
  normalizeHandleInput,
  resetRequestConfigSchema,
  type ResetRequestConfig,
} from '../config/schema.js';

const SUPPORTED_KEYS = new Set([
  'codexHome',
  'mode',
  'targetHandle',
  'replyText',
  'expectedXHandle',
  'cookieSource',
  'chromeProfile',
  'firefoxProfile',
  'maxPostAgeHours',
  'maxAttemptsPer24Hours',
]);

function parseNullable(value: string): string | null {
  return value === 'null' ? null : value;
}

export function setConfigValue(config: ResetRequestConfig, key: string, rawValue: string): ResetRequestConfig {
  if (!SUPPORTED_KEYS.has(key)) {
    throw new Error(`Unsupported config key: ${key}`);
  }
  if (key === 'mode' && rawValue === 'auto') {
    throw new Error('Use codex-reset-request enable-auto to enable automatic posting');
  }
  if (key === 'mode' && rawValue === 'notify') {
    throw new Error('Notify mode is not supported');
  }

  const next = structuredClone(config) as Record<string, unknown>;
  let value: unknown = rawValue;

  if (key === 'targetHandle' || key === 'expectedXHandle') {
    value = rawValue === 'null' ? null : normalizeHandleInput(rawValue);
  } else if (key === 'codexHome' || key === 'chromeProfile' || key === 'firefoxProfile') {
    value = parseNullable(rawValue);
  } else if (key === 'maxPostAgeHours' || key === 'maxAttemptsPer24Hours') {
    value = Number(rawValue);
  }

  const segments = key.split('.');
  if (segments.length === 1) {
    next[key] = value;
  } else {
    const parent = next[segments[0]] as Record<string, unknown>;
    parent[segments[1]] = value;
  }

  return resetRequestConfigSchema.parse(next);
}

export function registerConfigCommand(program: Command): void {
  const command = program.command('config').description('Show or update local configuration');

  command
    .command('show')
    .description('Print the validated configuration (never browser credentials)')
    .action(async () => {
      console.log(JSON.stringify(await loadConfig(), null, 2));
    });

  command
    .command('set <key> <value>')
    .description('Set one validated configuration value')
    .action(async (key: string, value: string) => {
      const saved = await saveConfig(setConfigValue(await loadConfig(), key, value));
      console.log(`Saved ${key} (${saved.mode})`);
    });

  command
    .command('reset')
    .description('Reset configuration to safe defaults')
    .action(async () => {
      await saveConfig(createDefaultConfig());
      console.log('Configuration reset. Mode is dry-run.');
    });
}
