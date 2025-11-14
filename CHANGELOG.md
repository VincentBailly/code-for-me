# Changelog

## 0.4.0

- Removed the `LLM: Send Prompt` command and its output channel in favor of the native VS Code Chat experience.
- Simplified the extension to only register the `@llm-workbench` chat participant.

## 0.3.0

- Removed the custom model-selection workflow and command; the extension now relies entirely on VS Code's built-in chat UI to choose models.
- Simplified the `llm.sendPrompt` command to use the first available chat model automatically.
- Cleaned up documentation to describe the leaner experience.

## 0.2.0

- Removed the experimental LLM Workbench Activity Bar view and its assets to keep the extension lean.
- Focused the experience on the proven command palette workflow plus the `@llm-workbench` chat participant.
- Updated documentation to reflect the streamlined flow.

## 0.1.0

- Introduced the **LLM Workbench** Activity Bar view with model selection, prompt input, and streaming responses.
- Added a VS Code Chat participant (`@LLM Workbench`) so the extension can answer prompts directly inside the native Chat UI.
- Synced model preferences across the Workbench, commands, and chat participant with global state storage.
- Created a dedicated webview UI with rich status messaging and error handling.

## 0.0.2

- Added **LLM: Select Model** command to let you pick which VS Code-hosted model should handle prompts.
- Remember the last selected model and reuse it for future prompts, with a quick pick fallback when multiple models are available.
- Added npm scripts `package:vsix` and `install:vsix` plus a helper installer to streamline packaging and installing the extension locally.

## 0.0.1

- Initial release with the `LLM: Send Prompt` command that forwards user input to the built-in VS Code language model API.
