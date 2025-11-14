import * as vscode from 'vscode';

const OUTPUT_CHANNEL_NAME = 'LLM Chat Output';
const SELECTED_MODEL_STATE_KEY = 'llm.selectedModelId';

type ModelQuickPickItem = vscode.QuickPickItem & { model: vscode.LanguageModelChat };

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);

	const sendPromptDisposable = vscode.commands.registerCommand('llm.sendPrompt', async () => {
		const prompt = await vscode.window.showInputBox({
			title: 'Send Prompt to VS Code LLM',
			prompt: 'Enter the message you want to send to the currently available language model.',
			placeHolder: 'Explain how VS Code language model APIs work…',
			ignoreFocusOut: true
		});

		if (!prompt || !prompt.trim()) {
			return;
		}

		outputChannel.appendLine(`# User\n${prompt}\n`);
		outputChannel.appendLine('## Assistant');
		outputChannel.show(true);

		try {
			const models = await vscode.lm.selectChatModels({});

			if (!models.length) {
				vscode.window.showWarningMessage('No language models are available in VS Code at the moment.');
				return;
			}

			const model = await resolveModelSelection(context, models, {
				title: 'Select a language model for this prompt'
			});

			if (!model) {
				return;
			}

			const response = await model.sendRequest(
				[
					vscode.LanguageModelChatMessage.User(prompt)
				],
				{
					justification: 'Send ad-hoc prompts from the vscode-lm-client sample extension.'
				}
			);

			for await (const fragment of response.text) {
				outputChannel.append(fragment);
			}

			outputChannel.appendLine('\n');
		} catch (error: unknown) {
			handleLanguageModelError(error);
		}
	});

	const selectModelDisposable = vscode.commands.registerCommand('llm.selectModel', async () => {
		try {
			const models = await vscode.lm.selectChatModels({});

			if (!models.length) {
				vscode.window.showWarningMessage('No language models are available in VS Code at the moment.');
				return;
			}

			const model = await pickModelFromUser(models, {
				title: 'Select default language model',
				placeHolder: 'Choose which VS Code language model should be used by default'
			});

			if (!model) {
				return;
			}

			await context.globalState.update(SELECTED_MODEL_STATE_KEY, model.id);
			vscode.window.showInformationMessage(`LLM default model set to ${describeModel(model)}.`);
		} catch (error: unknown) {
			handleLanguageModelError(error);
		}
	});

	context.subscriptions.push(sendPromptDisposable, selectModelDisposable, outputChannel);
}

export function deactivate() {}

async function resolveModelSelection(
	context: vscode.ExtensionContext,
	models: vscode.LanguageModelChat[],
	pickOptions?: { title?: string }
): Promise<vscode.LanguageModelChat | undefined> {
	if (models.length === 1) {
		await context.globalState.update(SELECTED_MODEL_STATE_KEY, models[0].id);
		return models[0];
	}

	const storedId = context.globalState.get<string>(SELECTED_MODEL_STATE_KEY);
	if (storedId) {
		const storedModel = models.find((model) => model.id === storedId);
		if (storedModel) {
			return storedModel;
		}

		vscode.window.showWarningMessage('The previously selected language model is unavailable. Please choose another one.');
	}

	const selectedModel = await pickModelFromUser(models, {
		title: pickOptions?.title ?? 'Select a language model',
		placeHolder: 'Choose which VS Code language model should answer your prompt'
	});

	if (!selectedModel) {
		return undefined;
	}

	await context.globalState.update(SELECTED_MODEL_STATE_KEY, selectedModel.id);
	return selectedModel;
}

async function pickModelFromUser(
	models: vscode.LanguageModelChat[],
	options?: { title?: string; placeHolder?: string }
): Promise<vscode.LanguageModelChat | undefined> {
	if (models.length === 1) {
		return models[0];
	}

	const items: ModelQuickPickItem[] = models.map((model) => ({
		label: model.name ?? model.family ?? model.id,
		description: `${model.vendor} • ${model.family} • v${model.version}`,
		detail: `Max input tokens: ${model.maxInputTokens.toLocaleString()}`,
		model
	}));

	const selection = await vscode.window.showQuickPick<ModelQuickPickItem>(items, {
		canPickMany: false,
		matchOnDescription: true,
		matchOnDetail: true,
		title: options?.title ?? 'Select language model',
		placeHolder: options?.placeHolder ?? 'Pick which model should be used',
		ignoreFocusOut: true
	});

	return selection?.model;
}

function describeModel(model: vscode.LanguageModelChat): string {
	const readableName = model.name || model.family || model.id;
	return `${readableName} (${model.vendor})`;
}

function handleLanguageModelError(error: unknown): void {
	if (error instanceof vscode.LanguageModelError) {
		vscode.window.showErrorMessage(`LLM request failed: ${error.message} (${error.code})`);
		return;
	}

	const message = error instanceof Error ? error.message : String(error);
	vscode.window.showErrorMessage(`LLM request failed: ${message}`);
}
