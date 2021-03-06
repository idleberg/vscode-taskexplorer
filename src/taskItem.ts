

import {
	ExtensionContext, Task, TaskExecution, TreeItem, TreeItemCollapsibleState,
	WorkspaceFolder, tasks
} from 'vscode';
import { TaskFile } from './taskFile';
import * as path from 'path';


export class TaskItem extends TreeItem 
{
	public static readonly defaultSource = "Workspace";

    public readonly task: Task | undefined;
    public readonly taskSource: string;
	public readonly execution: TaskExecution | undefined;
    public paused: boolean;

	taskFile: TaskFile;
	
	constructor(context: ExtensionContext, taskFile: TaskFile, task: Task) 
	{
		let taskName = task.name;
		if (taskName.indexOf(' - ') !== -1 && (taskName.indexOf('/') !== -1 || taskName.indexOf('\\') !== -1 || 
		                                       taskName.indexOf(' - tsconfig.json') !== -1)) {
			taskName = task.name.substring(0, task.name.indexOf(' - '));
		}

		super(taskName, TreeItemCollapsibleState.None);

        this.id = taskFile.resourceUri.fsPath + ":" + task.name + Math.floor(Math.random() * 1000000);
        this.paused = false;
		this.contextValue = 'script';
		this.taskFile = taskFile;
		this.task = task;
		this.command = {
			title: 'Open definition',
			command: 'taskExplorer.open',
			arguments: [this]
		};
		this.taskSource = task.source;
		this.execution = tasks.taskExecutions.find(e => e.task.name === task.name && e.task.source === task.source && 
			                                       e.task.scope === task.scope && e.task.definition.path === task.definition.path);
			
		this.contextValue = this.execution && task.definition.type !=="$composite" ? "runningScript" : "script";

		if (this.execution && task.definition.type !=="$composite") {
			this.iconPath = {
				light: context.asAbsolutePath(path.join('res', 'light', 'loading.svg')),
				dark: context.asAbsolutePath(path.join('res', 'dark', 'loading.svg'))
			};
		} else {
			this.iconPath = {
				light: context.asAbsolutePath(path.join('res', 'light', 'script.svg')),
				dark: context.asAbsolutePath(path.join('res', 'dark', 'script.svg'))
			};
		}

		this.tooltip = 'Open ' + task.name;
	}

	getFolder(): WorkspaceFolder {
		return this.taskFile.folder.workspaceFolder;
	}
}
