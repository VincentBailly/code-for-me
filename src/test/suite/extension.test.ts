import * as assert from 'assert';
import * as vscode from 'vscode';


describe('Extension Tests', () => {
	it('registers the LLM commands', async () => {
		const extension = vscode.extensions.getExtension('vingent.vscode-lm-client');
		assert.ok(extension, 'Expected extension to be discoverable');
		await extension?.activate();
		const allCommands = await vscode.commands.getCommands(true);
		assert.ok(
			allCommands.includes('llm.sendPrompt'),
			'Expected llm.sendPrompt command to be registered.'
		);
		assert.ok(
			allCommands.includes('llm.selectModel'),
			'Expected llm.selectModel command to be registered.'
		);
	});
});
