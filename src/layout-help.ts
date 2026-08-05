export const layoutHelpText = `Usage:
  bpmn-cli layout <file> [options]

Replace BPMN DI with a complete greenfield layout.

Profiles:
  --profile zeebe         Load the built-in Zeebe moddle profile
  --no-auto-profile       Disable namespace-based profile detection
  --extension <name>=<descriptor.json>
                          Load a data-only moddle descriptor; repeatable

Output:
  --output <path>         Write a separate BPMN file instead of replacing source
  --force                 Allow replacing the separate output file
  --json                  Emit versioned JSON
  -h, --help              Display this help message

Layout is published only when semantic hashes before and after are identical.
`;
