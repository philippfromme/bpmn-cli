# bpmn-cli

Node 20+ TypeScript ESM foundation for a future safe, scriptable BPMN moddle
editing CLI.

The project is currently in Phase 0. It exposes only discovery commands; BPMN
parsing, mutation commands, and an edit DSL are intentionally out of scope
until their contracts are approved in [PLAN.md](PLAN.md).

## Requirements

- Node.js 20 or later
- npm

## Development

```sh
npm install
npm run build
npm run typecheck
npm run lint
npm test
npm run test:coverage
```

## CLI

After building, run:

```sh
node dist/index.js --help
node dist/index.js --version
node dist/index.js capabilities
node dist/index.js capabilities --json
```

`capabilities` reports the implemented command surface and explicitly marks
future BPMN operations as planned. Its JSON output is versioned for reliable
agent and automation discovery.

`typescript` compiles and checks the ESM source. ESLint provides static linting,
and Node's built-in test runner covers the small public CLI contract without
adding a test framework dependency.
