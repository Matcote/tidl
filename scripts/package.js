#!/usr/bin/env node
const { packageRelease } = require('./lib/package');
try {
  const result = packageRelease({ allowFixture: process.argv.includes('--fixture') });
  console.log(`Packaged ${result.filename} (${result.checksum})`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
