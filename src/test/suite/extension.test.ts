import * as assert from 'assert';
import * as vscode from 'vscode';


describe('Extension Tests', () => {
	it('activates the LLM Workbench participant', async () => {
		const extension = vscode.extensions.getExtension('vingent.vscode-lm-client');
		assert.ok(extension, 'Expected extension to be discoverable');
		const api = await extension?.activate();
		assert.strictEqual(api, undefined, 'Activation should not return a custom API');
	});
});
