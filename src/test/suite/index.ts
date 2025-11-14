import * as path from 'path';
import Mocha from 'mocha';
import { globSync } from 'glob';

export async function run(): Promise<void> {
	const mocha = new Mocha({
		ui: 'bdd',
		color: true
	});

	const testsRoot = path.resolve(__dirname, '.');

	const files = globSync('**/**.test.js', { cwd: testsRoot });
	files.forEach((file) => mocha.addFile(path.resolve(testsRoot, file)));

	await new Promise<void>((c, e) => {
		mocha.run((failures: number) => {
			if (failures > 0) {
				e(new Error(`${failures} tests failed.`));
			} else {
				c();
			}
		});
	});
}
