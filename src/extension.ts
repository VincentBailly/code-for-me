import { spawn } from 'child_process';
import * as vscode from 'vscode';


export function activate(context: vscode.ExtensionContext) {
	const chatParticipant = vscode.chat.createChatParticipant('vingent.participant', async (request, _chatContext, stream, token) => {
		let i = 0;
		const workspaceUri = getRequiredWorkspaceUri();
		const chatRequestWithModel = request as vscode.ChatRequest & { model: vscode.LanguageModelChat };
		async function agentLoop(taskPrompt: string, savedNotes?: string): Promise<string> {
			if (i++ > 5) {
				return 'I have reached the maximum number of iterations.';
			}

			const contextSummary = buildContextSummary(taskPrompt, savedNotes);

			const canCompleteQuestion = `${contextSummary}\n\nQuestion: Can you write a single Node.js script that will gather all required information and at the same time perform every edits needed to fully satisfy the user request right now?\n\nAnswer format: respond with ONLY "YES" or "NO" on a single line. Answer "YES" only if you are really sure you have all you need to make this one-shot script. Do not add any explanation or additional text.`;
			const canCompleteResponse = await sendModelRequest(chatRequestWithModel.model, canCompleteQuestion, token, 'Assess ability to finish in one script');
			const canComplete = normalizeYesNo(canCompleteResponse);

			const codeObjective = canComplete === 'YES'
				? 'Write the Node.js source for index.js that completes the task in one run. It should gather any information it needs and apply all required edits.'
				: 'Write the Node.js source for index.js that focuses on gathering missing information or taking preparatory actions to make the task easier next iteration. Produce structured output or files the next assistant can rely on.';
			const codePrompt = `${contextSummary}\n\n${codeObjective}\n\nRules:\n- Output ONLY Node.js code (no backticks, no commentary).\n- Use workspace-relative paths.\n- Remember you cannot read or edit files directly; only this script will execute.\n- Any workspace modifications must be performed by this script (use fs APIs, child_process, etc.).\n- The only information that reaches the next step is this script plus its stdout/stderr, so print any file contents or summaries you want preserved.\n- Print concise progress updates if helpful.`;
			const rawCodeResponse = await sendModelRequest(chatRequestWithModel.model, codePrompt, token, 'Generate Node.js workspace script');
			const sanitizedCode = stripCodeFences(rawCodeResponse);
			const indexJsUri = vscode.Uri.joinPath(workspaceUri, 'index.js');
			const encoder = new TextEncoder();
			await vscode.workspace.fs.writeFile(indexJsUri, encoder.encode(sanitizedCode));

			const { output, errorOutput, exitCode } = await runScriptAndGetOutput(indexJsUri);
			const rendered = renderCommandResult(output, errorOutput, exitCode);

			const truncatedCode = truncateForPrompt(sanitizedCode, 4000);
			const truncatedResult = truncateForPrompt(rendered, 4000);
			const scriptSection = `<script>\n${truncatedCode}\n</script>`;
			const scriptOutputSection = `<scriptOutput>\n${truncatedResult}\n</scriptOutput>`;
			const canFinalizeQuestion = `${contextSummary}\n\nScript that just ran:\n${scriptSection}\n\nScript output summary:\n${scriptOutputSection}\n\nQuestion: Given these results, have all the necessary file modification been done? If so, are you now able to provide the final answer to the user and consider the task complete? If the answerw to both questions is "yes", respond with "YES", otherwise respond with "NO".\n\nAnswer format: respond with ONLY "YES" or "NO" on a single line. Do not add any explanation or additional text.`;
			const canFinalizeResponse = await sendModelRequest(chatRequestWithModel.model, canFinalizeQuestion, token, 'Assess ability to finalize');
			const canFinalize = normalizeYesNo(canFinalizeResponse);

			if (canFinalize === 'YES') {
				const finalAnswerPrompt = `${contextSummary}\n\nScript that just ran:\n${scriptSection}\n\nScript output summary:\n${scriptOutputSection}\n\nProvide the final response for the user. Clearly explain what the script already did and the current project state. Do not describe hypothetical or unexecuted changes.`;
				const finalAnswer = await sendModelRequest(chatRequestWithModel.model, finalAnswerPrompt, token, 'Deliver final answer to the user');
				return finalAnswer;
			}

			const notesPrompt = `${contextSummary}\n\nScript that just ran:\n${scriptSection}\n\nScript output summary:\n${scriptOutputSection}\n\nYou cannot finish yet. You are about to be rebooted and will lose all context. The ONLY thing that persists is the text you provide now, which will be handed verbatim to the next assistant. Provide exactly what they should know to continue effectively, including the precise file paths and the file contents or excerpts (inline in the note) that will save them from having to re-read files.`;
			const notesResponse = await sendModelRequest(chatRequestWithModel.model, notesPrompt, token, 'Capture next-iteration memory');
			const notesContent = notesResponse.trim();

			return agentLoop(taskPrompt, notesContent);
		}
		const response = await agentLoop(request.prompt);
		stream.markdown(response);


	});
	chatParticipant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'chat.svg');

	context.subscriptions.push(chatParticipant);
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

function buildContextSummary(taskPrompt: string, notes?: string): string {
	const sections: string[] = [];
	sections.push(`<task>\n${taskPrompt.trim()}\n</task>`);
	if (notes && notes.trim().length > 0) {
		sections.push(`<notes>\n${notes.trim()}\n</notes>`);
	}
	sections.push('<rules>\nYou cannot directly inspect the workspace. The only way to read or edit files is by writing Node.js code that runs as index.js. The next step only receives your script plus its stdout/stderr, so print any file contents or conclusions you want preserved.\n</rules>');
	return sections.join('\n\n');
}

async function sendModelRequest(model: vscode.LanguageModelChat, prompt: string, token: vscode.CancellationToken, justification: string): Promise<string> {
	const messages = [
		vscode.LanguageModelChatMessage.User(prompt, 'prompt')
	];
	const response = await model.sendRequest(messages, { justification }, token);
	let aggregated = '';
	for await (const fragment of response.text) {
		aggregated += fragment;
	}
	return aggregated;
}

function normalizeYesNo(response: string): 'YES' | 'NO' {
	const firstMeaningfulLine = response.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
	const normalized = firstMeaningfulLine.trim().toUpperCase();
	if (normalized === 'YES' || normalized.startsWith('YES')) {
		return 'YES';
	}
	return 'NO';
}

function stripCodeFences(text: string): string {
	const trimmed = text.trim();
	const fenceMatch = trimmed.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)```$/);
	if (fenceMatch) {
		return fenceMatch[1].trim();
	}
	return trimmed;
}

function truncateForPrompt(text: string, maxLength = 4000): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, maxLength)}\n\n...[truncated]`;
}
