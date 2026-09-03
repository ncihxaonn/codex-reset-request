#!/usr/bin/env node

import { createResetRequestProgram } from './program.js';
import { redactForLog } from './utils/redaction.js';

try {
  await createResetRequestProgram().parseAsync(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(String(redactForLog(message)));
  process.exitCode = 1;
}
