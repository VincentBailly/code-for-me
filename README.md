# VS Code LLM Client

This sample VS Code extension demonstrates how to send user prompts to a language model that is already available within VS Code. It relies entirely on the built-in `vscode.lm` API, so no additional authentication flows or custom endpoints are required.

## Features

- Command palette entry **LLM: Send Prompt** (`llm.sendPrompt`).
- Command palette entry **LLM: Select Model** (`llm.selectModel`) to pick the default VS Code-hosted model.
- Collects a prompt from the user and forwards it to the first available language model selected via `vscode.lm.selectChatModels`.
- Streams the assistant response into a dedicated output channel so you can keep the full conversation transcript.
- Provides straightforward error handling when no models are available or if the request fails for quota/consent reasons.

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
2. (Optional) Run **LLM: Select Model** to choose which VS Code-provided model should be used by default.
3. Open the command palette and run **LLM: Send Prompt**.
4. Enter any message; the extension selects your preferred model (or prompts you to choose) via `vscode.lm` and streams the answer to the **LLM Chat Output** channel.

## License

MIT
