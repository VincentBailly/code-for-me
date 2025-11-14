import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	const chatParticipant = vscode.chat.createChatParticipant('llmWorkbench.participant', async (request, chatContext, stream, token) => {
		try {
			const messages = buildMessagesFromChatContext(chatContext);
			messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

			const chatResponse = await request.model.sendRequest(messages, {
				justification: 'Answer chat prompts via the LLM Workbench participant.'
			}, token);

			for await (const fragment of chatResponse.text) {
				stream.markdown(fragment);
			}
		} catch (error: unknown) {
			stream.markdown(`$(error) ${getErrorMessage(error)}`);
			handleLanguageModelError(error);
		}
	});
	chatParticipant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'chat.svg');

	context.subscriptions.push(chatParticipant);
}

export function deactivate() {}

function handleLanguageModelError(error: unknown): void {
	const message = getErrorMessage(error);
	vscode.window.showErrorMessage(`LLM request failed: ${message}`);
}

function getErrorMessage(error: unknown): string {
	if (error instanceof vscode.LanguageModelError) {
		return `${error.message} (${error.code})`;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function buildMessagesFromChatContext(chatContext: vscode.ChatContext): vscode.LanguageModelChatMessage[] {
	const messages: vscode.LanguageModelChatMessage[] = [];
	const history = chatContext.history ?? [];
	for (const entry of history) {
		if (entry instanceof vscode.ChatRequestTurn) {
			messages.push(vscode.LanguageModelChatMessage.User(entry.prompt));
		} else if (entry instanceof vscode.ChatResponseTurn) {
			let assistantContent = '';
			for (const responsePart of entry.response ?? []) {
				if (responsePart instanceof vscode.ChatResponseMarkdownPart) {
					assistantContent += responsePart.value.value;
				}
			}
			if (assistantContent) {
				messages.push(vscode.LanguageModelChatMessage.Assistant(assistantContent));
			}
		}
	}
	return messages;
}
