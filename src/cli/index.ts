#!/usr/bin/env node
import { CommanderError } from 'commander';
import { AppError } from '../shared/errors.js';
import { createProgram } from './program.js';

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode;
  } else if (error instanceof AppError) {
    process.stderr.write(`[${error.code}] ${error.message}\n`);
    process.exitCode = error.code === 'CANCELLED' ? 130 : 1;
  } else {
    process.stderr.write('内部错误；请提供使用的命令及复现步骤。\n');
    process.exitCode = 1;
  }
}
