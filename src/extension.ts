import { spawn, SpawnOptionsWithoutStdio } from 'child_process';
import { promises as fsPromises } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';


export function activate(context: vscode.ExtensionContext) {
	const chatParticipant = vscode.chat.createChatParticipant('vingent.participant', async (request, _chatContext, stream, token) => {
		let i = 0;
		const workspaceUri = getRequiredWorkspaceUri();
		const chatRequestWithModel = request as vscode.ChatRequest & { model: vscode.LanguageModelChat };
		const overlay = await WorkspaceOverlay.create(workspaceUri);
		async function agentLoop(taskPrompt: string, savedNotes?: string): Promise<string> {
			if (i++ > 5) {
				return 'I have reached the maximum number of iterations.';
			}

			const contextSummary = buildContextSummary(taskPrompt, savedNotes);

			// Skip the "can complete" question on the first iteration - we always need to gather info first
			let canComplete: 'YES' | 'NO' = 'NO';
			if (savedNotes) {
				const canCompleteQuestion = `${contextSummary}\n\nQuestion: Can you write a single Node.js script that will gather all required information and at the same time perform every edits needed to fully satisfy the user request right now?\n\nAnswer format: respond with ONLY "YES" or "NO" on a single line. Answer "YES" only if you are really sure you have all you need to make this one-shot script. Do not add any explanation or additional text.`;
				const canCompleteResponse = await sendModelRequest(chatRequestWithModel.model, canCompleteQuestion, token, 'Assess ability to finish in one script');
				canComplete = normalizeYesNo(canCompleteResponse);
			}

			const codeObjective = canComplete === 'YES'
				? 'Write a Node.js script that completes the task in one run. It should gather any information you need and apply all required edits.'
				: 'Write the Node.js script that focuses on gathering missing information or taking preparatory actions to make the task easier next iteration.';
			const codePrompt = `${contextSummary}\n\n${codeObjective}\n\nRules:\n- Output ONLY Node.js code (no backticks, no commentary).\n- Use workspace-relative paths.\n- Remember you cannot read or edit files directly; only this script will execute.\n- Any workspace modifications must be performed by this script (use fs APIs, child_process, etc.).`;
			const rawCodeResponse = await sendModelRequest(chatRequestWithModel.model, codePrompt, token, 'Generate Node.js workspace script');
			const sanitizedCode = stripCodeFences(rawCodeResponse);
			const indexJsUri = overlay.indexJsUri;
			const encoder = new TextEncoder();
			await vscode.workspace.fs.writeFile(indexJsUri, encoder.encode(sanitizedCode));

			let commandResult: CommandResult;
			try {
				commandResult = await runScriptAndGetOutput(indexJsUri, overlay.cloneUri.fsPath);
			} finally {
				await overlay.clearTempScript().catch(() => undefined);
			}

			const { output, errorOutput, exitCode } = commandResult;
			const rendered = renderCommandResult(output, errorOutput, exitCode);

			const truncatedCode = truncateForPrompt(sanitizedCode, 12000);
			const truncatedResult = truncateForPrompt(rendered, 12000);
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

			const notesPrompt = `${contextSummary}\n\nScript that just ran:\n${scriptSection}\n\nScript output summary:\n${scriptOutputSection}\n\nWe are now in the process of compacting the context for the next iteration. Please re-write the current chat history, all details that are still relevant should be preserved, including relevant file contents, but details that are not necessary anymore for finishing the task should be omitted. Keep the same chat history structure as the input. You may need to re-write some parts to make sure that the deletion of details does not impact the overall understanding. The next iteration will start only the system prompt and the compacted chat history you provide here. In case of doubt, include more rather than less, never include system prompt or initial user instructions as they will be automatically preserved.`;
			const notesResponse = await sendModelRequest(chatRequestWithModel.model, notesPrompt, token, 'Capture next-iteration memory');
			const notesContent = notesResponse.trim();

			return agentLoop(taskPrompt, notesContent);
		}
		try {
			const response = await agentLoop(request.prompt);
			const finalizeResult = await overlay.finalize();

			// Apply changes to the workspace using the copilot_insertEdit tool
			if (finalizeResult.changes.length > 0) {
				for (const change of finalizeResult.changes) {
					const fileUri = vscode.Uri.joinPath(workspaceUri, change.relativePath);

					if (change.type === 'deleted') {
						const edit = new vscode.WorkspaceEdit();
						edit.deleteFile(fileUri);
						await vscode.workspace.applyEdit(edit);
						stream.markdown(`Deleted \`${change.relativePath}\`\n`);
					} else {
						// Use the copilot_insertEdit tool for creates and modifications
						const toolResult = await vscode.lm.invokeTool('copilot_insertEdit', {
							input: {
								explanation: change.type === 'created'
									? `Create new file ${change.relativePath}`
									: `Update ${change.relativePath}`,
								filePath: fileUri.fsPath,
								code: change.newContent
							},
							toolInvocationToken: request.toolInvocationToken
						}, token);

						// The tool result contains content parts we can examine
						if (toolResult.content) {
							for (const part of toolResult.content) {
								if (part instanceof vscode.LanguageModelTextPart) {
									stream.markdown(part.value);
								}
							}
						}
					}
				}
			}

			stream.markdown(response);
		} catch (error) {
			await overlay.finalize().catch(() => undefined);
			const message = error instanceof Error ? error.message : String(error);
			stream.markdown(`Agent execution failed: ${message}`);
		}


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

type CommandResult = { output: string; errorOutput: string; exitCode: number };

function executeCommand(command: string, args: string[], options?: SpawnOptionsWithoutStdio): Promise<CommandResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, options);
		let output = '';
		let errorOutput = '';

		child.stdout?.on('data', (data) => {
			output += data.toString();
		});

		child.stderr?.on('data', (data) => {
			errorOutput += data.toString();
		});

		child.on('close', (code) => {
			resolve({ output, errorOutput, exitCode: typeof code === 'number' ? code : 0 });
		});
		child.on('error', (err) => {
			resolve({ output, errorOutput: err.message, exitCode: -1 });
		});
	});
}

interface FileChange {
	relativePath: string;
	originalContent: string;
	newContent: string;
	type: 'modified' | 'created' | 'deleted';
}

class WorkspaceOverlay {
	private disposed = false;
	private finalizeResult?: { changes: FileChange[] };

	private constructor(
		private readonly workspaceUri: vscode.Uri,
		private readonly overlayRoot: string,
		readonly cloneUri: vscode.Uri,
		private readonly scriptDir: string,
		readonly indexJsUri: vscode.Uri
	) { }

	static async create(workspaceUri: vscode.Uri): Promise<WorkspaceOverlay> {
		const overlayRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'vingent-overlay-'));
		const workspaceBasename = path.basename(workspaceUri.fsPath);
		const cloneParent = overlayRoot;
		const srcPath = workspaceUri.fsPath;
		let copyResult = await executeCommand('cp', ['-cR', srcPath, cloneParent]);
		if (copyResult.exitCode !== 0) {
			await fsPromises.rm(path.join(cloneParent, workspaceBasename), { recursive: true, force: true }).catch(() => undefined);
			copyResult = await executeCommand('cp', ['-R', srcPath, cloneParent]);
		}
		if (copyResult.exitCode !== 0) {
			await fsPromises.rm(overlayRoot, { recursive: true, force: true }).catch(() => undefined);
			const reason = copyResult.errorOutput || copyResult.output || 'Failed to duplicate workspace for overlay usage.';
			throw new Error(reason.trim());
		}

		const clonePath = path.join(cloneParent, workspaceBasename);
		const cloneUri = vscode.Uri.file(clonePath);
		const scriptDir = await fsPromises.mkdtemp(path.join(overlayRoot, 'script-'));
		const indexJsUri = vscode.Uri.file(path.join(scriptDir, 'index.js'));
		return new WorkspaceOverlay(workspaceUri, overlayRoot, cloneUri, scriptDir, indexJsUri);
	}

	async finalize(): Promise<{ changes: FileChange[] }> {
		if (this.disposed) {
			return this.finalizeResult ?? { changes: [] };
		}
		this.disposed = true;
		let record: { changes: FileChange[] } | undefined;
		try {
			const changes = await this.collectChanges();
			record = { changes };
			return record;
		} finally {
			this.finalizeResult = record;
			await fsPromises.rm(this.overlayRoot, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private async collectChanges(): Promise<FileChange[]> {
		const changes: FileChange[] = [];
		const workspacePath = this.workspaceUri.fsPath;
		const clonePath = this.cloneUri.fsPath;

		// Get all files in both directories
		const originalFiles = await this.getAllFiles(workspacePath);
		const cloneFiles = await this.getAllFiles(clonePath);

		const allRelativePaths = new Set([...originalFiles, ...cloneFiles]);

		for (const relativePath of allRelativePaths) {
			const originalPath = path.join(workspacePath, relativePath);
			const clonedPath = path.join(clonePath, relativePath);

			const originalExists = originalFiles.has(relativePath);
			const cloneExists = cloneFiles.has(relativePath);

			if (!originalExists && cloneExists) {
				// New file created
				const newContent = await fsPromises.readFile(clonedPath, 'utf8');
				changes.push({ relativePath, originalContent: '', newContent, type: 'created' });
			} else if (originalExists && !cloneExists) {
				// File deleted
				const originalContent = await fsPromises.readFile(originalPath, 'utf8');
				changes.push({ relativePath, originalContent, newContent: '', type: 'deleted' });
			} else if (originalExists && cloneExists) {
				// Check if modified
				const originalContent = await fsPromises.readFile(originalPath, 'utf8');
				const newContent = await fsPromises.readFile(clonedPath, 'utf8');
				if (originalContent !== newContent) {
					changes.push({ relativePath, originalContent, newContent, type: 'modified' });
				}
			}
		}

		return changes;
	}

	private async getAllFiles(dirPath: string, basePath: string = dirPath): Promise<Set<string>> {
		const files = new Set<string>();
		const entries = await fsPromises.readdir(dirPath, { withFileTypes: true }).catch(() => []);

		for (const entry of entries) {
			const fullPath = path.join(dirPath, entry.name);
			const relativePath = path.relative(basePath, fullPath);

			// Skip common directories that shouldn't be compared
			if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.DS_Store') {
				continue;
			}

			if (entry.isDirectory()) {
				const subFiles = await this.getAllFiles(fullPath, basePath);
				for (const subFile of subFiles) {
					files.add(subFile);
				}
			} else if (entry.isFile()) {
				files.add(relativePath);
			}
		}

		return files;
	}

	async clearTempScript(): Promise<void> {
		await fsPromises.rm(this.indexJsUri.fsPath, { force: true }).catch(() => undefined);
	}
}

function runScriptAndGetOutput(scriptUri: vscode.Uri, workingDirectory: string): Promise<{ output: string, errorOutput: string, exitCode: number }> {
	return executeCommand('node', [scriptUri.fsPath], { cwd: workingDirectory, env: process.env });
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

function truncateForPrompt(text: string, maxLength = 12000): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, maxLength)}\n\n...[truncated]`;
}
