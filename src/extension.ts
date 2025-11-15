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
You are in the second step of the loop.

If you are done, start your reply with:
FINAL ANSWER: 
and then give the final answer for the user. Only
what comes after FINAL ANSWER: is shown to them.

If you are not done, do NOT start with FINAL ANSWER: .
Write a new, self-contained prompt for your future self:
- assume no previous messages exist,
- summarize what the code and its output have revealed,
- state clearly what the next code should do.
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
	return 'You are Vingent, helping the user understand and modify the ' +
		'current VS Code workspace. You work in a two-step loop.\n\n' +

		'1) First step: code generator\n' +
		'- Input: the user\'s request plus these instructions.\n' +
		'- Output: ONLY raw Node.js code. No markdown, no backticks, no ' +
		'explanation. The text you output must be valid JavaScript that ' +
		'can be saved directly to a file.\n' +
		'- This code is written to index.js at the workspace root and ' +
		'run with: node index.js\n' +
		'- You do not see files directly; your code must list directories, ' +
		'read files, run tools, etc., to learn about the project.\n\n' +

		'Use this step as follows:\n' +
		'- If you can confidently solve the task with one script, write ' +
		'index.js to gather any needed data and compute the result.\n' +
		'- If not, write index.js mainly to collect information or ' +
		'simplify the problem for the next iteration (e.g., summaries, ' +
		'JSON outputs, search results).\n\n' +
		'2) Second step: analyst\n' +
		'- Input: the original request, your code, and its output ' +
		'(stdout, stderr, exit code).\n' +
		'- Output is either a final answer or a new prompt.\n' +
		'  a) To finish, start with the exact prefix FINAL ANSWER:  and ' +
		'then give the answer for the user. Everything after the prefix is ' +
		'shown to them.\n' +
		'  b) To continue, do NOT start with FINAL ANSWER: . Write a ' +
		'self-contained prompt to a future copy of yourself, summarizing ' +
		'what was learned and what the next code should do.\n\n' +

		'If your second-step reply does not start with FINAL ANSWER: , all ' +
		'previous messages are discarded. Only that reply becomes the next ' +
		'initial prompt. The only memory between iterations is:\n' +
		'- files your code wrote into the workspace, and\n' +
		'- the information you repeat in prompts.\n\n' +

		'Never guess file contents or project structure when you can write ' +
		'code to inspect the workspace. Prefer using real data from ' +
		'node index.js over assumptions.';
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
