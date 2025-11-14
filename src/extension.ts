import { spawn } from 'child_process';
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

			let aggregatedResponse = '';
			for await (const fragment of chatResponse.text) {
				aggregatedResponse += fragment;
			}
			// write the content of the response to index.js at the root of the workspace
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) {
				throw new Error('No workspace folder is open.');
			}
			const workspaceUri = workspaceFolders[0].uri;
			const indexJsUri = vscode.Uri.joinPath(workspaceUri, 'index.js');
			const encoder = new TextEncoder();
			await vscode.workspace.fs.writeFile(indexJsUri, encoder.encode(aggregatedResponse));

			const { output, errorOutput, exitCode } = await runScriptAndGetOutput(indexJsUri);
			const rendered = renderCommandResult(output, errorOutput, exitCode);

			const messages2 = [
				vscode.LanguageModelChatMessage.User(getSystemPrompt(), 'system'),
				vscode.LanguageModelChatMessage.User(request.prompt),
				vscode.LanguageModelChatMessage.Assistant(aggregatedResponse),
				vscode.LanguageModelChatMessage.User(rendered),
				vscode.LanguageModelChatMessage.User(reminderOfWhatsNext(), 'user')

			];

			const chatResponse2 = await chatRequestWithModel.model.sendRequest(messages2, {
				justification: 'Answer chat prompts via the Vingent participant.'
			}, token);

			for await (const fragment of chatResponse2.text) {
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

function reminderOfWhatsNext(): string {
	return [
		'<reminder>',
		"Your next response either starts with the string 'FINAL ANSWER: ' followed by your final answer to the user's original question, or it will be treated a brand new user prompt and the cycle will repeat.",
		"If you are providing not providing a final answer, make sure that you provide an english prompt and not code.",
		'</reminder>'
	].join(' ');
}

function renderCommandResult(output: string, errorOutput: string, exitCode: number): string {
	let result = `**Command executed with exit code ${exitCode}.**\n\n`;

	if (output) {
		result += `\n\n**Standard Output:**\n\`\`\`\n${output}\n\`\`\``;
	}

	if (errorOutput) {
		result += `\n\n**Error Output:**\n\`\`\`\n${errorOutput}\n\`\`\``;
	}

	return result;
}

function runScriptAndGetOutput(scriptUri: vscode.Uri): Promise<{ output: string, errorOutput: string, exitCode: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn('node', [scriptUri.fsPath,], { cwd: vscode.workspace.rootPath });
		let output = '';
		let errorOutput = '';

		child.stdout.on('data', (data) => {
			output += data.toString();
		});

		child.stderr.on('data', (data) => {
			errorOutput += data.toString();
		});

		child.on('close', (code) => {
			resolve({ output, errorOutput, exitCode: code || 0 });
		});
		child.on('error', (err) => {
			resolve({ output, errorOutput: err.message, exitCode: -1 });
		});
	});
}
export function deactivate() { }

function getSystemPrompt(): string {
	return [
		'You are Vingent, an assistant that helps VS Code users understand and modify the workspace they currently have open.',
		'You have only one way to interact with the workspace: the response you will return will be written as the content of the file "index.js" in the root of the workspace. The command "node index.js" will then be run and the output will be returned to you. When you get the output, your next response will be taken as the next prompt and the loop will repeat until you provide an answer starts with the string "FINAL ANSWER: "',
		"Your response to the first request will be copied as is into index.js and executed with node. Do not output anything that is not valid JavaScript code. Do not wrap the script in code blocks or quotes.",
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
