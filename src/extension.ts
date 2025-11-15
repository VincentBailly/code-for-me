import { spawn } from 'child_process';
import { promises } from 'dns';
import * as vscode from 'vscode';


export function activate(context: vscode.ExtensionContext) {
	const chatParticipant = vscode.chat.createChatParticipant('vingent.participant', async (request, _chatContext, stream, token) => {
		let i = 0;
		const workspaceUri = getRequiredWorkspaceUri();
		const interactionLogs: string[] = [];
		interactionLogs.push(formatLogSection('Initial Prompt', request.prompt));
		async function agentLoop(initialPrompt: string): Promise<string> {
			if (i++ > 5) {
				return 'I have reached the maximum number of iterations.';
			}
			const messages = [
				vscode.LanguageModelChatMessage.User(getSystemPrompt(), 'systemPrompt'),
				vscode.LanguageModelChatMessage.User(initialPrompt, 'initialPrompt')
			];

			const chatRequestWithModel = request as vscode.ChatRequest & { model: vscode.LanguageModelChat };
			const chatResponse = await chatRequestWithModel.model.sendRequest(messages, {
				justification: 'Answer chat prompts via the Vingent participant.'
			}, token);

			let aggregatedResponse = '';
			for await (const fragment of chatResponse.text) {
				aggregatedResponse += fragment;
			}
			interactionLogs.push(formatCodeSection(`Iteration ${i} - Model Code Response`, aggregatedResponse));
			// write the content of the response to index.js at the root of the workspace
			const indexJsUri = vscode.Uri.joinPath(workspaceUri, 'index.js');
			const encoder = new TextEncoder();
			await vscode.workspace.fs.writeFile(indexJsUri, encoder.encode(aggregatedResponse));

			const { output, errorOutput, exitCode } = await runScriptAndGetOutput(indexJsUri);
			const rendered = renderCommandResult(output, errorOutput, exitCode);
			interactionLogs.push(formatLogSection(`Iteration ${i} - Command Result`, rendered));

			const messages2 = [
				vscode.LanguageModelChatMessage.User(getSystemPrompt(), 'systemPrompt'),
				vscode.LanguageModelChatMessage.User(initialPrompt, 'initialPrompt'),
				vscode.LanguageModelChatMessage.Assistant(aggregatedResponse, 'codeResponse'),
				vscode.LanguageModelChatMessage.User(rendered, 'commandResult'),
				vscode.LanguageModelChatMessage.User(reminderOfWhatsNext(), 'reminderOfWhatsNext')

			];

			const chatResponse2 = await chatRequestWithModel.model.sendRequest(messages2, {
				justification: 'Answer chat prompts via the Vingent participant.'
			}, token);

			const finalAnswerPrefix = 'FINAL ANSWER: ';
			let finalAnswer = '';
			for await (const fragment of chatResponse2.text) {
				finalAnswer += fragment;
			}
			interactionLogs.push(formatLogSection(`Iteration ${i} - Model English Response`, finalAnswer));

			if (finalAnswer.startsWith(finalAnswerPrefix)) {
				const answerContent = finalAnswer.slice(finalAnswerPrefix.length).trim();
				return answerContent
			} else {
				// Not a final answer, repeat the loop
				return agentLoop(finalAnswer);
			}

		}
		const response = await agentLoop(request.prompt)

		try {
			await writeInteractionLogs(workspaceUri, interactionLogs);
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to write Vingent logs: ${getErrorMessage(error)}`);
		}

		stream.markdown(response);


	});
	chatParticipant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'chat.svg');

	context.subscriptions.push(chatParticipant);
}

function reminderOfWhatsNext(): string {
	return `
	Are you done with the task? If so, respond with 'FINAL ANSWER: ' followed by your final answer to the user's original question. This message will be detected as a final answer and displayed to the user.

	If you are not done, it's okay, you can iterate some more. To prevent keeping useless information in memory, we are going to wipe all context after your next response, including the initial user request. Your next response will become the initial prompt given. Give all the information and instructions that you will need to fulfill the user's original request. Your prompt can contain as much context as you judge useful, including code snippets, file paths, explanations, it can even be something that only you can make sense of and that has emojis or non-english characters if you think it will help get a better result.

	Your response will be fed back to you as is, but without any other context or history. The user will not see your prompt response unless it is a final answer. There is not mechanism for you to ask aditional information to the user or give intermediate feedback.
`;
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

function getRequiredWorkspaceUri(): vscode.Uri {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		throw new Error('No workspace folder is open.');
	}
	return workspaceFolders[0].uri;
}

async function writeInteractionLogs(workspaceUri: vscode.Uri, logs: string[]): Promise<void> {
	const logUri = vscode.Uri.joinPath(workspaceUri, 'vingent_logs.md');
	const encoder = new TextEncoder();
	const content = logs.join('\n\n');
	await vscode.workspace.fs.writeFile(logUri, encoder.encode(content));
}

function formatLogSection(title: string, content: string): string {
	return `## ${title}\n\n${content}`;
}

function formatCodeSection(title: string, code: string): string {
	return formatLogSection(title, ['```javascript', code, '```'].join('\n'));
}

function getSystemPrompt(): string {
	return `
		You are Vingent, an assistant that helps VS Code users understand and modify the workspace they currently have open.

		You interact with the workspace in a fixed two-step loop. Each step of the loop consists of asking the model (you) to respond to a prompt.

		- The first prompt will contain the description of the task and possibly some extra context. Your response to this prompt must be valid nodejs code, unquoted.
		- The second prompt but a copy of the previous prompt, to which is added your previous response (the code), and the result of executing that code (standard output, error output, and exit code). Your response to this prompt can be treated in two different ways:
			- If your response starts with the string "FINAL ANSWER: ", then everything after that prefix is considered your final answer to the user. This will be displayed to the user as is, and the loop ends.
			- Otherwise, your response is treated as a new prompt for the next iteration of the loop, exactly the same way as if the user had provided it as the initial prompt.

		Here is some pseudo-code describing the loop:

		\`\`\`javascript
		function agentLoop(initialPrompt) {
			const codeResponse = model.sendRequest([
				systemPrompt,
				initialPrompt
			])

			const codeOutput = runScriptAndGetOutput(codeResponse);
			const secondResponse = model.sendRequest([
				systemPrompt,
				initialPrompt,
				codeResponse,
				codeOutput,
				reminderOfWhatsNext
			])
			if (secondResponse.startsWith("FINAL ANSWER: ")) {
				return secondResponse.slice("FINAL ANSWER: ".length)
			} else {
				return agentLoop(secondResponse)
			}
 		}
		\`\`\`

		You will only be rewarded for the quality of your final answer, there is no need to rush or guess information that you can look up in the next iteration of the loop.
		If you need more information about the workspace, do not guess it, just provide the code to extract it and use it to build a better prompt with better context for the next iteration.
`;
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
