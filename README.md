# VS Code LLM Client

This sample VS Code extension demonstrates how to send user prompts to a language model that is already available within VS Code. It relies entirely on the built-in `vscode.lm` API, so no additional authentication flows or custom endpoints are required.

## Features

- Built-in chat participant (`@llm-workbench`) so you can reuse the VS Code Chat surface with no extra wiring.
- Automatically uses the first VS Code-managed chat model that’s available—no extra selection UI needed.

## Requirements

- Visual Studio Code `1.93.0` or newer (for the `vscode.lm` API surface).
- Access to at least one VS Code-managed language model (for example, GitHub Copilot Chat).

## Development

Install dependencies:

```bash
npm install
```

Compile TypeScript:

```bash
npm run compile
```

Run the integration tests (launches VS Code in test mode):

```bash
npm test
```

Bundle a VSIX (using the local `vsce` dev dependency):

```bash
npm run package:vsix
```

Package and install into your main VS Code instance (requires the `code` CLI on your PATH):

```bash
npm run install:vsix
```

## Usage

1. Press `F5` to launch a new Extension Development Host.
2. Open the Chat view, mention `@llm-workbench`, and start asking questions.
3. The extension streams responses directly in the Chat panel using whichever built-in model is available.

## License

MIT
