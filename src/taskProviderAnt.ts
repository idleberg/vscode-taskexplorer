
import {
    Task, TaskGroup, WorkspaceFolder, RelativePattern, ShellExecution, Uri,
    workspace, TaskProvider, TaskDefinition, TextEditorRevealType, Range, window
} from 'vscode';
import * as path from 'path';
import * as util from './util';
import { parseString } from 'xml2js';
import { configuration } from "./common/configuration";
import { TaskItem } from './taskItem';
type StringMap = { [s: string]: string; };

let cachedTasks: Task[] = undefined;


interface AntTaskDefinition extends TaskDefinition 
{
	script?: string;
	path?: string;
	fileName?: string;
	uri?: Uri;
	treeItem?: TaskItem;
}

export class AntTaskProvider implements TaskProvider 
{
	constructor() {
	}

	public provideTasks() {
		return provideAntScripts();
	}

	public resolveTask(_task: Task): Task | undefined {
		return undefined;
	}
}


export async function invalidateTasksCacheAnt(opt?: Uri) : Promise<void> 
{
	util.log('');
	util.log('invalidateTasksCacheAnt');

	if (opt && cachedTasks) 
	{
		let rmvTasks: Task[] = [];

		cachedTasks.forEach(each => {
			let cstDef: AntTaskDefinition = each.definition;
			if (cstDef.uri.fsPath === opt.fsPath || !util.pathExists(cstDef.uri.fsPath)) {
				rmvTasks.push(each);
			}
		});

		rmvTasks.forEach(each => {
			util.log('   removing old task ' + each.name);
			util.removeFromArray(cachedTasks, each);
		});

		//
		// If this isn't a 'delete file' event then read the file for tasks
		//
		if (util.pathExists(opt.fsPath) && !util.existsInArray(configuration.get("exclude"), opt.path))
		{
			let tasks = await readAntfile(opt);
			cachedTasks.push(...tasks);
		}

		if (cachedTasks.length > 0) {
			return;
		}
	}

	cachedTasks = undefined;
}


async function detectAntScripts(): Promise<Task[]> 
{

	let emptyTasks: Task[] = [];
	let allTasks: Task[] = [];
	let visitedFiles: Set<string> = new Set();

	let folders = workspace.workspaceFolders;
	if (!folders) {
		return emptyTasks;
	}
	try {
		for (const folder of folders) 
		{
			let relativePattern = new RelativePattern(folder, '**/[Bb]uild.xml');

			let xtraIncludes: string[] = configuration.get('includeAnt');
			if (xtraIncludes && xtraIncludes.length > 0) {
				let multiFilePattern: string = '{**/[Bb]uild.xml';
				if (Array.isArray(xtraIncludes)) 
				{
					for (var i in xtraIncludes) {
						multiFilePattern += ',';
						multiFilePattern += xtraIncludes[i];
					}
				}
				else {
					multiFilePattern += ',';
					multiFilePattern += xtraIncludes;
				}
				multiFilePattern += '}';
				relativePattern = new RelativePattern(folder, multiFilePattern);
			}
			
			let paths = await workspace.findFiles(relativePattern, util.getExcludesGlob(folder));
			for (const fpath of paths) 
			{
				if (!util.isExcluded(fpath.path) && !visitedFiles.has(fpath.fsPath)) {
					let tasks = await readAntfile(fpath);
					visitedFiles.add(fpath.fsPath);
					allTasks.push(...tasks);
				}
			}
		}
		return allTasks;
	} catch (error) {
		return Promise.reject(error);
	}
}


export async function provideAntScripts(): Promise<Task[]> 
{
	if (!cachedTasks) {
		cachedTasks = await detectAntScripts();
	}
	return cachedTasks;
}


async function readAntfile(uri: Uri): Promise<Task[]> 
{
	let emptyTasks: Task[] = [];

	let folder = workspace.getWorkspaceFolder(uri);
	if (!folder) {
		return emptyTasks;
    }
    
    let contents = await util.readFile(uri.fsPath);

	let scripts = await findAllAntScripts(contents);
	if (!scripts) {
		return emptyTasks;
	}

	const result: Task[] = [];

	Object.keys(scripts).forEach(each => {
		const task = createAntTask(scripts[`${each}`] ? scripts[`${each}`] : `${each}`, each, folder!, uri);
		if (task) {
			task.group = TaskGroup.Build;
			result.push(task);
		}
	});

	return result;
}


async function findAllAntScripts(buffer: string): Promise<StringMap> 
{
	let json: any = '';
	let scripts: StringMap = {};

	util.log('');
	util.log('FindAllAntScripts');

	try {
		parseString(buffer, function (err, result) {
			if (err) {
				util.log('   Script file cannot be parsed');
				return scripts;
			}
			json = result;
		});
	}
	catch(e) {
		util.log('   Script file cannot be parsed');
				return scripts;
	}

	if (!json || !json.project)
	{
		util.log('   Script file does not contain a <project> root');
		return scripts;
	}

	if (!json.project.target)
	{
		util.log('   Script file does not contain any targets');
		return scripts;
	}

	let defaultTask = json.project.$.default;

	//if (json.project.$.default) {
    //util.logValue('   Found default target', json.project.$.default);
	//	scripts["Default (" + json.project.$.default + ")"] = json.project.$.default;
	//}

	let targets = json.project.target;
	for (var tgt in targets)
	{
		if (targets[tgt].$ && targets[tgt].$.name) {
			util.logValue('   Found target', targets[tgt].$.name);
			scripts[defaultTask === targets[tgt].$.name ? targets[tgt].$.name + " - Default" : targets[tgt].$.name] = targets[tgt].$.name;
		}
		else {
			util.log('   Invalid target found');
		}
	}

	return scripts;
}


function createAntTask(target: string, cmdName: string, folder: WorkspaceFolder, uri: Uri): Task 
{
	function getCommand(folder: WorkspaceFolder): string 
	{
		let ant = "ant";

		if (process.platform === 'win32') {
			ant = "ant.bat";
		}

		if (workspace.getConfiguration('taskExplorer').get('pathToAnt')) {
			ant = workspace.getConfiguration('taskExplorer').get('pathToAnt');
			if (process.platform === 'win32' && ant.endsWith("\\ant")) {
				ant += '.bat';
			}
		}

		return ant; 
	}

	function getRelativePath(folder: WorkspaceFolder, uri: Uri): string 
	{
		if (folder) {
			let rootUri = folder.uri;
			let absolutePath = uri.path.substring(0, uri.path.lastIndexOf('/') + 1);
			return absolutePath.substring(rootUri.path.length + 1);
		}
		return '';
	}
	
	let antFile = path.basename(uri.path);

	let kind: AntTaskDefinition = {
		type: 'ant',
		script: target,
		path: '', // populated below if relativePath is non-empty
		fileName: antFile,
		uri: uri
	};

	let relativePath = getRelativePath(folder, uri);
	if (relativePath.length) {
		kind.path = relativePath;
	}
	let cwd = path.dirname(uri.fsPath);

	let args = [ target ];
	let options = null;
	
	if (process.platform === 'win32' && configuration.get('enableAnsiconForAnt') === true)
	{
		let ansicon = "ansicon.exe";
		let ansiPath: string = configuration.get('pathToAnsicon');
		if (ansiPath && util.pathExists(ansiPath)) {
			ansicon = ansiPath;
			if (!ansicon.endsWith('ansicon.exe') && !ansicon.endsWith('\\')) {
				ansicon = path.join(ansicon, 'ansicon.exe');
			}
			else if (!ansicon.endsWith('ansicon.exe')) {
				ansicon += 'ansicon.exe';
			}
		}
		
		args = [ "-logger", "org.apache.tools.ant.listener.AnsiColorLogger", target ];
		options = {
			"cwd": cwd,
			"executable": ansicon
		};
	}
	else
	{
		options = {
			"cwd": cwd
		};
	}

	if (antFile.toLowerCase() !== 'build.xml')
	{
		args.push('-f');
		args.push(antFile);
	}

	let execution = new ShellExecution(getCommand(folder), args, options);
	
	return new Task(kind, folder, cmdName ? cmdName : target, 'ant', execution, undefined);
}
