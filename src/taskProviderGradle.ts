
import
{
    Task, TaskGroup, WorkspaceFolder, RelativePattern, ShellExecution, Uri,
    workspace, TaskProvider, TaskDefinition
} from "vscode";
import * as path from "path";
import * as util from "./util";
import { TaskItem } from "./taskItem";
import { configuration } from "./common/configuration";

type StringMap = { [s: string]: string; };

let cachedTasks: Task[] = undefined;


interface GradleTaskDefinition extends TaskDefinition 
{
    script?: string;
    path?: string;
    fileName?: string;
    uri?: Uri;
    treeItem?: TaskItem;
}

export class GradleTaskProvider implements TaskProvider 
{
    constructor()
    {
    }

    public provideTasks()
    {
        return provideGradlefiles();
    }

    public resolveTask(_task: Task): Task | undefined
    {
        return undefined;
    }
}


export async function invalidateTasksCacheGradle(opt?: Uri): Promise<void> 
{
    util.log("");
    util.log("invalidateTasksCacheAnt");

    if (opt && cachedTasks) 
    {
        let rmvTasks: Task[] = [];
        let uri: Uri = opt as Uri;

        cachedTasks.forEach(each =>
        {
            let cstDef: GradleTaskDefinition = each.definition;
            if (cstDef.uri.fsPath === opt.fsPath || !util.pathExists(cstDef.uri.fsPath))
            {
                rmvTasks.push(each);
            }
        });

        rmvTasks.forEach(each =>
        {
            util.log("   removing old task " + each.name);
            util.removeFromArray(cachedTasks, each);
        });

        if (util.pathExists(opt.fsPath) && !util.existsInArray(configuration.get("exclude"), opt.path))
        {
            let tasks = await readGradlefile(opt);
            cachedTasks.push(...tasks);
        }

        if (cachedTasks.length > 0)
        {
            return;
        }
    }

    cachedTasks = undefined;
}


async function detectGradlefiles(): Promise<Task[]> 
{

    let emptyTasks: Task[] = [];
    let allTasks: Task[] = [];
    let visitedFiles: Set<string> = new Set();
    let folders = workspace.workspaceFolders;

    util.log("", 1);
    util.log("Find gradlefiles", 1);

    if (!folders)
    {
        return emptyTasks;
    }
    try 
    {
        for (const folder of folders) 
        {
            //
            // Note - pattern will ignore gradlefiles in root project dir, which would be picked
            // up by VSCoces internal Gradle task provider
            //
            let relativePattern = new RelativePattern(folder, "**/*.[Gg][Rr][Aa][Dd][Ll][Ee]");
            let paths = await workspace.findFiles(relativePattern, util.getExcludesGlob(folder));
            for (const fpath of paths) 
            {
                if (!util.isExcluded(fpath.path) && !visitedFiles.has(fpath.fsPath))
                {
                    util.log("   found " + fpath.fsPath, 1);
                    let tasks = await readGradlefile(fpath);
                    visitedFiles.add(fpath.fsPath);
                    allTasks.push(...tasks);
                }
            }
        }

        util.log("   done");
        return allTasks;
    }
    catch (error)
    {
        return Promise.reject(error);
    }
}


export async function provideGradlefiles(): Promise<Task[]> 
{
    if (!cachedTasks)
    {
        cachedTasks = await detectGradlefiles();
    }
    return cachedTasks;
}


async function readGradlefile(uri: Uri): Promise<Task[]> 
{
    let emptyTasks: Task[] = [];

    let folder = workspace.getWorkspaceFolder(uri);
    if (!folder)
    {
        return emptyTasks;
    }

    let scripts = await findTargets(uri.fsPath);
    if (!scripts)
    {
        return emptyTasks;
    }

    const result: Task[] = [];

    Object.keys(scripts).forEach(each =>
    {
        const task = createGradleTask(each, `${each}`, folder!, uri);
        if (task)
        {
            task.group = TaskGroup.Build;
            result.push(task);
        }
    });

    return result;
}


async function findTargets(fsPath: string): Promise<StringMap> 
{
    let json: any = "";
    let scripts: StringMap = {};

    util.log("   Find gradlefile targets");

    let contents = await util.readFile(fsPath);
    let idx = 0;
    let eol = contents.indexOf("\n", 0);

    while (eol !== -1)
    {
        let line: string = contents.substring(idx, eol).trim();
        if (line.length > 0 && line.toLowerCase().trimLeft().startsWith("task ")) 
        {
            let idx1 = line.trimLeft().indexOf(" ");
            if (idx1 !== -1)
            {
                idx1++;
                let idx2 = line.indexOf("(", idx1);
                if (idx2 === -1) {
                    idx2 = line.indexOf("{", idx1);
                }
                if (idx2 !== -1)
                {
                    let tgtName = line.substring(idx1, idx2).trim();

                    if (tgtName)
                    {
                        scripts[tgtName] = "";
                        util.log("      found target");
                        util.logValue("         name", tgtName);
                    }
                }
            }
        }

        idx = eol + 1;
        eol = contents.indexOf("\n", idx);
    }

    return scripts;
}


function createGradleTask(target: string, cmd: string, folder: WorkspaceFolder, uri: Uri): Task 
{
    function getCommand(folder: WorkspaceFolder, cmd: string): string 
    {
        let gradle = "gradle";

        if (process.platform === "win32")
        {
            gradle = "gradle.bat";
        }

        if (workspace.getConfiguration("taskExplorer").get("pathToGradle"))
        {
            gradle = workspace.getConfiguration("taskExplorer").get("pathToGradle");
        }

        return gradle;
    }

    function getRelativePath(folder: WorkspaceFolder, uri: Uri): string 
    {
        if (folder)
        {
            let rootUri = folder.uri;
            let absolutePath = uri.path.substring(0, uri.path.lastIndexOf("/") + 1);
            return absolutePath.substring(rootUri.path.length + 1);
        }
        return "";
    }

    let kind: GradleTaskDefinition = {
        type: "gradle",
        script: target,
        path: "",
        fileName: path.basename(uri.path),
        uri: uri
    };

    let relativePath = getRelativePath(folder, uri);
    if (relativePath.length)
    {
        kind.path = relativePath;
    }
    let cwd = path.dirname(uri.fsPath);

    let args = [target];
    let options = {
        "cwd": cwd
    };

    let execution = new ShellExecution(getCommand(folder, cmd), args, options);

    return new Task(kind, folder, target, "gradle", execution, undefined);
}
