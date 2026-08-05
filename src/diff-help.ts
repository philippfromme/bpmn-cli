export const diffHelpText = `Usage:
  bpmn-cli diff <before.bpmn> <after.bpmn> [options]

Compare two BPMN models with bpmn-js-differ.

Selection:
  --include-layout        Include DI changes separately

Profiles:
  --profile zeebe         Load the built-in Zeebe moddle profile
  --no-auto-profile       Disable namespace-based profile detection
  --extension <name>=<descriptor.json>
                          Load a data-only moddle descriptor; repeatable

Output:
  --json                  Emit versioned JSON
  --report <path>         Write complete JSON to a new file
  --force                 Allow replacing the report file
  -h, --help              Display this help message

Different models are successful results with changed=true.
`;
