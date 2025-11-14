#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const { readdirSync, statSync } = require('node:fs');
const { resolve } = require('node:path');

function findLatestVsix() {
	const files = readdirSync(process.cwd())
		.filter((file) => file.endsWith('.vsix'))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

	return files[0];
}

function main() {
	const vsix = findLatestVsix();

	if (!vsix) {
		console.error('No VSIX artifacts found. Run "npm run package:vsix" first.');
		process.exitCode = 1;
		return;
	}

	const absPath = resolve(vsix);
	console.log(`Installing ${absPath} via VS Code CLI...`);

	try {
		execFileSync('code', ['--install-extension', absPath], {
			stdio: 'inherit'
		});
		console.log('Extension installed successfully.');
	} catch (error) {
		console.error('Failed to install the VSIX via the VS Code CLI.');
		if (error.stderr) {
			console.error(error.stderr.toString());
		}
		process.exitCode = 1;
	}
}

main();
