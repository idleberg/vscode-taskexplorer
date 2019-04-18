/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as util from './util';

import {
	Event, EventEmitter, ExtensionContext, Task, TaskDefinition,
	TextDocument, TreeDataProvider, TreeItem, TreeItemCollapsibleState, Uri,
	commands, window, workspace, tasks, Selection, WorkspaceFolder, InputBoxOptions,
	CancellationToken, ShellExecution
} from 'vscode';
import { visit, JSONVisitor } from 'jsonc-parser';
import * as nls from 'vscode-nls';
import { TaskFolder } from './taskFolder';
import { TaskFile } from './taskFile';
import { TaskItem } from './taskItem';
import { configuration } from "./common/configuration";
import { invalidateTasksCacheAnt } from './taskProviderAnt';
import { invalidateTasksCacheMake } from './taskProviderMake';
import { invalidateTasksCacheScript } from './taskProviderScript';
import { invalidateTasksCacheGrunt } from './taskProviderGrunt';
import { invalidateTasksCacheGulp } from './taskProviderGulp';


const localize = nls.loadMessageBundle();


class NoScripts extends TreeItem
{
	constructor() {
		super(localize('noScripts', 'No scripts found'), TreeItemCollapsibleState.None);
		this.contextValue = 'noscripts';
	}
}


export class TaskTreeDataProvider implements TreeDataProvider<TreeItem>
{
	private taskTree: TaskFolder[] | TaskFile[] | NoScripts[] | null = null;
	private extensionContext: ExtensionContext;
	private _onDidChangeTreeData: EventEmitter<TreeItem | null> = new EventEmitter<TreeItem | null>();
	readonly onDidChangeTreeData: Event<TreeItem | null> = this._onDidChangeTreeData.event;

	constructor(name: string, context: ExtensionContext)
	{
		const subscriptions = context.subscriptions;
		this.extensionContext = context;
		subscriptions.push(commands.registerCommand(name + '.run', this.run, this));
		subscriptions.push(commands.registerCommand(name + '.stop', (taskTreeItem: TaskItem) =>
		{
            if (taskTreeItem.execution) {
				taskTreeItem.execution.terminate();
            }
        }, this));
		subscriptions.push(commands.registerCommand(name + '.open', this.open, this));
		subscriptions.push(commands.registerCommand(name + '.refresh', this.refresh, this));
		subscriptions.push(commands.registerCommand(name + '.runInstall', this.runInstall, this));

		tasks.onDidStartTask(() => this.refresh(false));
		tasks.onDidEndTask(() => this.refresh(false));
	}


	private invalidateTasksCache(invalidate?: any) 
	{
		//
		// All internal task providers export an invalidate() function...
		//
		if (invalidate && typeof invalidate === 'string')
		{
			if (invalidate === 'ant') {
				invalidateTasksCacheAnt();
			}
			else if (invalidate === 'grunt') {
				invalidateTasksCacheGrunt();
			}
			else if (invalidate === 'gulp') {
				invalidateTasksCacheGulp();
			}
			else if (invalidate === 'make') {
				invalidateTasksCacheMake();
			}
			else {
				invalidateTasksCacheScript();
			}
		}
		else
		{
			invalidateTasksCacheAnt();
			invalidateTasksCacheMake();
			invalidateTasksCacheScript();
			invalidateTasksCacheGrunt();
			invalidateTasksCacheGulp();
		}
	}


	private async run(taskItem: TaskItem)
	{
		//
		// If this is a script, check to see if args are required
		//
		// A script task will set the 'requiresArgs' parameter to true if command line arg
		// parameters are detected in the scripts contents when inported.  For example, if a
		// batch script contains %1, %2, etc, the task definition's requiresArgs parameter
		// will be set.
		//
		if (taskItem.task.definition.requiresArgs === true)
		{
			let opts: InputBoxOptions = { prompt: 'Enter command line arguments separated by spaces'};
			window.showInputBox(opts).then(function(str)
			{
				if (str !== undefined)
				{
					//let origArgs = taskItem.task.execution.args ? taskItem.task.execution.args.slice(0) : []; // clone
					if (str) {
						//origArgs.push(...str.split(' '));
						taskItem.task.execution  = new ShellExecution(taskItem.task.definition.cmdLine + ' ' + str, taskItem.task.execution.options);
					}
					else {
						taskItem.task.execution  = new ShellExecution(taskItem.task.definition.cmdLine, taskItem.task.execution.options);
					}
					tasks.executeTask(taskItem.task)
					.then(function(execution) {
						//taskItem.task.execution.args = origArgs.slice(0); // clone
					},
					function(reason) {
						//taskItem.task.execution.args = origArgs.slice(0); // clone
					});
				}
			});
		}
		else
		{
			//
			// Execute task
			//
			tasks.executeTask(taskItem.task);
		}
	}


	private findScriptPosition(document: TextDocument, script?: TaskItem): number
	{
		let me = this;
		let scriptOffset = 0;
		let inScripts = false;
		let inTasks = false;
		let inTaskLabel = undefined;
		let documentText = document.getText();

		util.log('findScriptPosition');
		util.logValue('   task source', script.taskSource);
		util.logValue('   task name', script.task.name);

		if (script.taskSource === 'tsc')
		{
			scriptOffset = 0;
		}
		if (script.taskSource === 'make')
		{
			scriptOffset = documentText.indexOf(script.task.name + ":");
			if (scriptOffset === -1) {
				scriptOffset = documentText.indexOf(script.task.name);
				let bLine = documentText.lastIndexOf('\n', scriptOffset) + 1;
				let eLine = documentText.indexOf('\n', scriptOffset);
				if (eLine === -1) { eLine = documentText.length; }
				let line = documentText.substring(bLine, eLine).trim();
				while (bLine !== -1 && bLine !== scriptOffset && scriptOffset !== -1 && line.indexOf(':') === -1) {
					scriptOffset = documentText.indexOf(script.task.name, scriptOffset + 1);
					bLine = documentText.lastIndexOf('\n', scriptOffset) + 1;
					eLine = documentText.indexOf('\n', scriptOffset);
					if (bLine !== -1) {
						if (eLine === -1) { eLine = documentText.length; }
						line = documentText.substring(bLine, eLine).trim();
					}
				}
				if (scriptOffset === -1) {
					scriptOffset = 0;
				}
			}
		}
		else if (script.taskSource === 'ant')
		{
			//
			// TODO This is crap - need regex search
			//
			scriptOffset = documentText.indexOf("name=\"" + script.task.name);
			if (scriptOffset === -1) {
				scriptOffset = documentText.indexOf("name='" + script.task.name);
			}
			if (scriptOffset === -1) {
				scriptOffset = 0;
			}
			else {
				scriptOffset += 6;
			}
		}
		else if (script.taskSource === 'gulp')
		{
			//
			// TODO This is crap - need regex search
			//
			scriptOffset = documentText.indexOf("gulp.task('" + script.task.name);
			if (scriptOffset === -1) {
				scriptOffset = documentText.indexOf("gulp.task(\"" + script.task.name);
			}
			if (scriptOffset === -1) {
				scriptOffset = 0;
			}
		}
		else if (script.taskSource === 'grunt')
		{
			//
			// TODO This is crap - need regex search
			//
			scriptOffset = documentText.indexOf("grunt.registerTask('" + script.task.name);
			if (scriptOffset === -1) {
				scriptOffset = documentText.indexOf("grunt.registerTask(\"" + script.task.name);
			}
			if (scriptOffset === -1) {
				scriptOffset = 0;
			}
		}
		else if (script.taskSource === 'npm' || script.taskSource === 'Workspace')
		{
			let visitor: JSONVisitor = {
				onError() {
					return scriptOffset;
				},
				onObjectEnd() {
					if (inScripts) {
						inScripts = false;
					}
				},
				onLiteralValue(value: any, offset: number, _length: number) {
					if (inTaskLabel) {
						if (typeof value === 'string') {
							if (inTaskLabel === 'label')
							{
								if (script.task.name === value) {
									scriptOffset = offset;
								}
							}
						}
						inTaskLabel = undefined;
					}
				},
				onObjectProperty(property: string, offset: number, _length: number) {
					if (property === 'scripts') {
						inScripts = true;
						if (!script) { // select the script section
							scriptOffset = offset;
						}
					}
					else if (inScripts && script) {
						let label = me.getTaskName(property, script.task.definition.path, true);
						if (script.task.name === label) {
							scriptOffset = offset;
						}
					}
					else if (property === 'tasks') {
						inTasks = true;
						if (!inTaskLabel) { // select the script section
							scriptOffset = offset;
						}
					}
					else if (property === 'label' && inTasks && !inTaskLabel) {
						inTaskLabel = 'label';
						if (!inTaskLabel) { // select the script section
							scriptOffset = offset;
						}
					}
					else { // nested object which is invalid, ignore the script
						inTaskLabel = undefined;
					}
				}
			};

			visit(documentText, visitor);
		}

		util.logValue('   Offset', scriptOffset);
		return scriptOffset;
	}


	private async open(selection: TaskFile | TaskItem)
	{
		let uri: Uri | undefined = undefined;
		if (selection instanceof TaskFile) {
			uri = selection.resourceUri!;
		} else if (selection instanceof TaskItem) {
			uri = selection.taskFile.resourceUri;
		}
		if (!uri) {
			return;
		}

		util.log('Open script at position');
		util.logValue('   command', selection.command.command);
		util.logValue('   source', selection.taskSource);
		util.logValue('   path', uri.path);
		util.logValue('   file path', uri.fsPath);

		if (util.pathExists(uri.fsPath)) {
			let document: TextDocument = await workspace.openTextDocument(uri);
			let offset = this.findScriptPosition(document, selection instanceof TaskItem ? selection : undefined);
			let position = document.positionAt(offset);
			await window.showTextDocument(document, { selection: new Selection(position, position) });
		}
		else {
			util.log('Invalid path for file, cannot open');
		}
	}


	public refresh(invalidate?: any)
	{
		this.taskTree = null;
		if (invalidate !== false) {
			this.invalidateTasksCache(invalidate);
		}
		this._onDidChangeTreeData.fire();
	}


	private async runInstall(taskFile: TaskFile)
	{
		if (taskFile.label.startsWith('npm'))
		{
			let options = {
				"cwd": path.dirname(taskFile.resourceUri.fsPath)
			};
			let execution = new ShellExecution('npm', [ 'install' ], options);
			let kind: TaskDefinition = {
				type: 'npm',
				script: 'install',
				path: path.dirname(taskFile.resourceUri.fsPath)
			};
			let task = new Task(kind, taskFile.folder.workspaceFolder, 'install', 'npm', execution, undefined);

			tasks.executeTask(task);
		}
		else{
			window.showInformationMessage('Only npm nodes can run npm installs');
		}
	}


	getTreeItem(element: TreeItem): TreeItem
	{
		return element;
	}


	getParent(element: TreeItem): TreeItem | null
	{
		if (element instanceof TaskFolder) {
			return null;
		}
		if (element instanceof TaskFile) {
			return element.folder;
		}
		if (element instanceof TaskItem) {
			return element.taskFile;
		}
		if (element instanceof NoScripts) {
			return null;
		}
		return null;
	}


	async getChildren(element?: TreeItem): Promise<TreeItem[]>
	{
		let items: any = [];
		
		util.log('');
		util.log('Tree get children');

		if (!this.taskTree) 
		{
			util.log('   Build task tree');
			//
			// TODO - search enable* settings and apply enabled types to filter
			//
			//let taskItems = await tasks.fetchTasks({ type: 'npm' });
			let taskItems = await tasks.fetchTasks();
			if (taskItems) {
				this.taskTree = this.buildTaskTree(taskItems);
				if (this.taskTree.length === 0) {
					this.taskTree = [new NoScripts()];
				}
			}
		}

		if (element instanceof TaskFolder) {
			util.log('   Get folder task files');
			items = element.taskFiles;
		}
		else if (element instanceof TaskFile) {
			util.log('   Get file tasks/scripts');
			items = element.scripts;
		}
		else if (!element) {
			util.log('   Get task tree');
			if (this.taskTree) {
				items = this.taskTree;
			}
		}

		return items;
	}


	private isInstallTask(task: Task): boolean
	{
		let fullName = this.getTaskName('install', task.definition.path);
		return fullName === task.name;
	}


	private getTaskName(script: string, relativePath: string | undefined, forcePathInName?: boolean)
	{
		if (relativePath && relativePath.length && forcePathInName === true) {
			return `${script} - ${relativePath.substring(0, relativePath.length - 1)}`;
		}
		return script;
	}


	private isWorkspaceFolder(value: any): value is WorkspaceFolder
	{
		return value && typeof value !== 'number';
	}


	private buildTaskTree(tasks: Task[]): TaskFolder[] | NoScripts[]
	{
		var taskCt = 0;
		let folders: Map<String, TaskFolder> = new Map();
		let files: Map<String, TaskFile> = new Map();
		let folder = null;
		let taskFile = null;

		//
		// Loop through each task provided by the engine and build a task tree
		//
		tasks.forEach(each =>
		{
			taskCt++;
			util.log('');
			util.log('Processing task ' + taskCt.toString() + ' of ' + tasks.length.toString());
			util.logValue('   name', each.name, 2);
			util.logValue('   source', each.source, 2);

			let settingName: string = 'enable' + util.properCase(each.source);
			if (configuration.get(settingName) && this.isWorkspaceFolder(each.scope) && !this.isInstallTask(each))
			{
				folder = folders.get(each.scope.name);
				if (!folder) {
					folder = new TaskFolder(each.scope);
					folders.set(each.scope.name, folder);
				}
				let definition: TaskDefinition = <TaskDefinition>each.definition;
				let relativePath = definition.path ? definition.path : '';

				//
				// TSC tasks are returned with no path value, the relative path is in the task name:
				//
				//     watch - tsconfig.json
				//     watch - .vscode-test\vscode-1.32.3\resources\app\tsconfig.schema.json
				//
				if (each.source === 'tsc')
				{
					if (each.name.indexOf(' - ') !== -1 && each.name.indexOf(' - tsconfig.json') === -1)
					{
						relativePath = path.dirname(each.name.substring(each.name.indexOf(' - ') + 3));
						let excluded: boolean = false;
						if (util.isExcluded(path.join(each.scope.uri.path, relativePath))) {
							return; // continue forEach loop
						}
						
					}
				}

				//
				// Create an id so group tasks together with
				//
				let id = each.source + ':' + path.join(each.scope.name, relativePath);
				if (definition.fileName && !definition.scriptFile) {
					id = path.join(id, definition.fileName);
				}

				//
				// Logging
				//
				util.logValue('   scope.name', each.scope.name, 2);
				util.logValue('   scope.uri.path', each.scope.uri.path, 2);
				util.logValue('   scope.uri.fsPath', each.scope.uri.fsPath, 2);
				util.logValue('   relative Path', relativePath, 2);
				util.logValue('   type', definition.type, 2);
				if (definition.scriptType) {
					util.logValue('      script type', definition.scriptType, 2);	// if 'script' is defined, this is type npm
				}
				if (definition.script) {
					util.logValue('   script', definition.script, 2);	// if 'script' is defined, this is type npm
				}
				if (definition.path) {
					util.logValue('   path', definition.path, 2);
				}
				//
				// Internal task providers will set a fileName property
				//
				if (definition.fileName) {
					util.logValue('   file name', definition.fileName, 2);
				}
				//
				// Script task providers will set a fileName property
				//
				if (definition.requiresArgs) {
					util.logValue('   script requires args', 'true', 2);
				}
				if (definition.cmdLine) {
					util.logValue('   script cmd line', definition.cmdLine, 2);
				}

				taskFile = files.get(id);
				//
				// Create taskfile node if needed
				//
				if (!taskFile)
				{
					taskFile = new TaskFile(this.extensionContext, folder, definition, each.source, relativePath);
					folder.addTaskFile(taskFile);
					files.set(id, taskFile);
					util.logValue('   Added source file container', each.source);
				}
				//
				// Create and add task item to task file node
				//
				let taskItem = new TaskItem(this.extensionContext, taskFile, each);
				taskFile.addScript(taskItem);
			}
			else {
				util.log('   Skipping');
				util.logValue('   enabled', configuration.get(settingName));
				util.logValue('   is install task', this.isInstallTask(each));
			}
		});

		//
		// Sort nodes.  By default the project folders are sorted in the same order as that
		// of the Explorer.  Sort TaskFile nodes and TaskItems nodes alphabetically, by default
		// its entirley random as to when the individual providers report tasks to the engine
		//
		let subfolders: Map<String, TaskFile> = new Map();
		
		folders.forEach((folder, key) => 
		{
			folder.taskFiles.forEach(each => {
				each.scripts.sort(function(a, b) {
					return a.label.localeCompare(b.label);
				});
			});

			folder.taskFiles.sort(function(a, b) {
				return a.taskSource.localeCompare(b.taskSource);
			});

			let prevTask: TaskFile;
			folder.taskFiles.forEach(each => 
			{
				if (prevTask && prevTask.taskSource === each.taskSource)
				{
					let id = folder.label + each.taskSource;
					let subfolder: TaskFile = subfolders.get(id);
					if (!subfolder) {
						subfolder = new TaskFile(this.extensionContext, folder, each.scripts[0].task.definition, each.taskSource, each.path, true); //(each.scripts[0].getFolder());
						subfolders.set(id, subfolder);
						folder.addTaskFile(subfolder);
						subfolder.addScript(prevTask);
					}
					subfolder.addScript(each);
				}
				prevTask = each;
			});

			let taskTypesRmv: Array<TaskFile> = [];
			folder.taskFiles.forEach(each => {
				let id = folder.label + each.taskSource;
				if (!each.isGroup && subfolders.get(id)) {
					taskTypesRmv.push(each);
				}
			});

			taskTypesRmv.forEach(each => {
				folder.removeTaskFile(each);
			});

			//
			// Resort after making adds/removes
			//
			folder.taskFiles.sort(function(a, b) {
				return a.taskSource.localeCompare(b.taskSource);
			});
		});

		//if (folders.size === 1) { // return just fi
		//	return [...packages.values()];
		//}
		return [...folders.values()];
	}
}
