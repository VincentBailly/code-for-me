import { spawn, SpawnOptionsWithoutStdio } from 'child_process';
import { promises as fsPromises } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';


export function activate(context: vscode.ExtensionContext) {
	const chatParticipant = vscode.chat.createChatParticipant('vingent.participant', async (request, _chatContext, stream, token) => {
		let i = 0;
		const workspaceUri = getRequiredWorkspaceUri();
		const overlay = await WorkspaceOverlay.create(workspaceUri);

		// Get a fast model for summarization
		const fastModels = await vscode.lm.selectChatModels({ id: 'gpt-4.1' });
		const fastModel = fastModels[0] ?? request.model;

		async function agentLoop(taskPrompt: string, savedNotes?: string): Promise<string> {
			if (i++ > 5) {
				return 'I have reached the maximum number of iterations.';
			}

			const contextSummary = buildContextSummary(taskPrompt, savedNotes);

			const agentPrompt = `${contextSummary}\n\nYou are a seasoned fully autonomous coding agent who understands that working iteratively - splitting the task into small steps - produces better results. You are participating to a competition between 10 coding agents who are all given the same task and the highest quality result will be used and all the other ones dismissed. Your script will run, you'll see the output, and then you can run another script — repeat as many time as you need until the task is done. The time or number of iterations is not considered for the competition, only the final result is. Agents producing code changes unrelated to the task will be immediately disqualified.

Respond with a Node.js script. The script runs in the workspace root. Use relative paths or process.cwd().

Examples of things you can do:
- Explore: fs.readFileSync(), fs.readdirSync(), console.log() to understand the codebase
- Modify: fs.writeFileSync(), fs.mkdirSync(), etc.
- Run commands: child_process.execSync() or spawn

Output ONLY the script (no backticks, no commentary).`;
			const rawResponse = await sendModelRequest(request.model, agentPrompt, token, 'Agent iteration');
			const sanitizedResponse = stripCodeFences(rawResponse);

			// Execute the script and summarize it in parallel
			const indexJsUri = overlay.indexJsUri;
			const encoder = new TextEncoder();
			await vscode.workspace.fs.writeFile(indexJsUri, encoder.encode(sanitizedResponse));

			const summarizePromise = sendModelRequest(fastModel, `Summarize this script in 5-10 words (what it does, not how):\n\n${truncateForPrompt(sanitizedResponse, 4000)}`, token, 'Summarize script').then(summary => {
				stream.markdown(`**Iteration ${i}:** ${summary.trim()}\n\n`);
			}).catch(() => undefined);

			let commandResult: CommandResult;
			try {
				commandResult = await runScriptAndGetOutput(indexJsUri, overlay.cloneUri.fsPath);
			} finally {
				await overlay.clearTempScript().catch(() => undefined);
			}

			await summarizePromise;

			const { output, errorOutput, exitCode } = commandResult;
			const rendered = renderCommandResult(output, errorOutput, exitCode);

			const truncatedCode = truncateForPrompt(sanitizedResponse, 12000);
			const truncatedResult = truncateForPrompt(rendered, 12000);
			const scriptSection = `<script>\n${truncatedCode}\n</script>`;
			const scriptOutputSection = `<scriptOutput>\n${truncatedResult}\n</scriptOutput>`;

			const notesPrompt = `${contextSummary}\n\nScript that just ran:\n${scriptSection}\n\nScript output summary:\n${scriptOutputSection}\n\nRespond with either:\n1. Compacted context for next iteration. CRITICAL: Be very conservative when summarizing. You must preserve ALL file contents that are still relevant for future steps. Do not summarize code if it might be needed later. It is better to keep too much context than too little. Remove only details that are clearly no longer needed (like intermediate script outputs that have been processed).\n2. A final summary for the user if the task is complete.\n\nTo indicate a final summary, start your response with "FINAL:". Otherwise your response will be used as notes for the next iteration.`;
			const notesResponse = await sendModelRequest(request.model, notesPrompt, token, 'Capture next-iteration memory or finalize');
			const notesContent = notesResponse.trim();

			if (notesContent.startsWith('FINAL:')) {
				return notesContent.slice(6).trim();
			}

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
