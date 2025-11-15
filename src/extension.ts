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
				vscode.LanguageModelChatMessage.User(getSystemPrompt(), 'system'),
				vscode.LanguageModelChatMessage.User(initialPrompt)
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
				vscode.LanguageModelChatMessage.User(getSystemPrompt(), 'system'),
				vscode.LanguageModelChatMessage.User(initialPrompt),
				vscode.LanguageModelChatMessage.Assistant(aggregatedResponse),
				vscode.LanguageModelChatMessage.User(rendered),
				vscode.LanguageModelChatMessage.User(reminderOfWhatsNext(), 'user')

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
	return [
		'<reminder>',
		"Your next response either starts with the string 'FINAL ANSWER: ' followed by your final answer to the user's original question, or it will be treated as a brand new user prompt and the cycle will repeat from the start.",
		"Each cycle has exactly two steps and always runs to completion:",
		"1) Step 1: you output JavaScript code only. That code is saved to index.js and executed with 'node index.js'.",
		"2) Step 2: you receive the command output and must reply with plain English (you may include code snippets), not executable code. This English reply is used as the next user prompt for Step 1 of the following cycle.",
		"This two-step cycle is fixed. It cannot be paused, cancelled, or resumed mid-way. It always runs Step 1 then Step 2, until you finally return a response starting with 'FINAL ANSWER: '.",
		"Use the prefix 'FINAL ANSWER: ' only when you are completely done and are returning your final response to the user's original question. Do not use 'FINAL ANSWER: ' for intermediate plans, prompts, or partial results.",
		"If you are not providing a final answer, make sure that you provide an English prompt which can contain code snippets if needed, but do not start it with 'FINAL ANSWER: '.",
		"Keep in mind that your English prompt will be the only context available to the next loop iteration, so if you need to remember anything, including the original question or goals, make sure you express it in that prompt. For example, restate the original question, any constraints, goals, or partial results you still need.",
		"This agent loop is minimal: there is no way to get any further input from the user after the initial request.",
		"Each agent loop iteration starts fresh with a new context. The only context the model receives is: the fixed system prompt and the single English prompt provided by the user (for the first iteration) or by your previous English reply (for later iterations).",
		"For the entire interaction, every code step (Step 1) must be followed by exactly one English prompt step (Step 2), and every English prompt step must be followed by exactly one code step in the next cycle, until you produce 'FINAL ANSWER: ...'.",
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
	return [
		'You are Vingent, an assistant that helps VS Code users understand and modify the workspace they currently have open.',
		'You interact with the workspace in a fixed two-step loop. Step 1: your response is written as the content of "index.js" in the workspace root and executed with the command "node index.js". Step 2: you receive the command output and must reply with an English prompt (you may include code snippets) for the next iteration.',
		"Your response to the first request (Step 1 of the first loop) must be valid JavaScript code only. It will be copied as-is into index.js and executed with node. Do not output anything that is not valid JavaScript. Do not wrap the script in code blocks or quotes.",
		'This two-step loop (code, then English prompt) repeats until you provide a response that starts with the string "FINAL ANSWER: ". Any response that starts with "FINAL ANSWER: " is treated as your final answer to the user and stops the loop. Do not use the prefix "FINAL ANSWER: " for intermediate prompts, plans, or partial results.',
		'This is not a subagent: in each new loop iteration you start from a clean context, except for what you explicitly restate in your English prompt. Any context not restated there is lost.'
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
