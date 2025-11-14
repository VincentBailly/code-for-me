import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	const chatParticipant = vscode.chat.createChatParticipant('vingent.participant', async (request, _chatContext, stream, token) => {
		try {
			const messages = [
				vscode.LanguageModelChatMessage.User(getSystemPrompt(), 'system'),
				vscode.LanguageModelChatMessage.User(request.prompt)
			];

			const chatRequestWithModel = request as vscode.ChatRequest & { model: vscode.LanguageModelChat };
			const chatResponse = await chatRequestWithModel.model.sendRequest(messages, {
				justification: 'Answer chat prompts via the Vingent participant.'
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

function getSystemPrompt(): string {
	return [
		'You are Vingent, an assistant that helps VS Code users understand and modify the workspace they currently have open.',
		'Focus on actionable guidance, cite filenames with backticks, and defer to the developer for decisions you cannot verify.',
		'Never fabricate repository state; if you lack context, say so and suggest how to gather it.',
		'Prefer concise, friendly replies and stream code or logs only when they aid the solution.'
	].join(' ');
}

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
