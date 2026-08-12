#!/usr/bin/env node

const command = process.argv[2];

switch (command) {
  case "run":
    process.stdout.write("Linger runner is not implemented yet.\n");
    break;
  case "manage":
    process.stdout.write("Linger account manager is not implemented yet.\n");
    break;
  case "--help":
  case "-h":
  case undefined:
    process.stdout.write("Usage: linger <run|manage>\n");
    break;
  default:
    process.stderr.write(`Unknown command: ${command}\n`);
    process.exitCode = 1;
}
