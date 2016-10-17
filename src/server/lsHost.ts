/// <reference path="..\services\services.ts" />
/// <reference path="utilities.ts" />
/// <reference path="scriptInfo.ts" />

namespace ts.server {
    export class LSHost implements ts.LanguageServiceHost, ModuleResolutionHost, ServerLanguageServiceHost {
        private compilationSettings: ts.CompilerOptions;
        private readonly resolvedModuleNames= createFileMap<Map<ResolvedModuleWithFailedLookupLocations>>();
        private readonly resolvedTypeReferenceDirectives = createFileMap<Map<ResolvedTypeReferenceDirectiveWithFailedLookupLocations>>();
        private readonly getCanonicalFileName: (fileName: string) => string;

        private readonly resolveModuleName: typeof resolveModuleName;
        readonly trace: (s: string) => void;

        constructor(private readonly host: ServerHost, private readonly project: Project, private readonly cancellationToken: HostCancellationToken) {
            this.getCanonicalFileName = ts.createGetCanonicalFileName(this.host.useCaseSensitiveFileNames);

            if (host.trace) {
                this.trace = s => host.trace(s);
            }

            this.resolveModuleName = (moduleName, containingFile, compilerOptions, host) => {
                const globalCache = this.project.getTypingOptions().enableAutoDiscovery
                    ? this.project.projectService.typingsInstaller.globalTypingsCacheLocation
                    : undefined;
                return resolveModuleNameForLsHost(moduleName, containingFile, compilerOptions, host, globalCache, this.project.getProjectName())
            };
        }

        private resolveNamesWithLocalCache<T extends { failedLookupLocations: string[] }, R>(
            names: string[],
            containingFile: string,
            cache: ts.FileMap<Map<T>>,
            loader: (name: string, containingFile: string, options: CompilerOptions, host: ModuleResolutionHost) => T,
            getResult: (s: T) => R,
            getResultFileName: (result: R) => string): R[] {

            const path = toPath(containingFile, this.host.getCurrentDirectory(), this.getCanonicalFileName);
            const currentResolutionsInFile = cache.get(path);

            const newResolutions: Map<T> = createMap<T>();
            const resolvedModules: R[] = [];
            const compilerOptions = this.getCompilationSettings();
            const lastDeletedFileName = this.project.projectService.lastDeletedFile && this.project.projectService.lastDeletedFile.fileName;

            for (const name of names) {
                // check if this is a duplicate entry in the list
                let resolution = newResolutions[name];
                if (!resolution) {
                    const existingResolution = currentResolutionsInFile && currentResolutionsInFile[name];
                    if (moduleResolutionIsValid(existingResolution)) {
                        // ok, it is safe to use existing name resolution results
                        resolution = existingResolution;
                    }
                    else {
                        newResolutions[name] = resolution = loader(name, containingFile, compilerOptions, this);
                    }
                }

                ts.Debug.assert(resolution !== undefined);

                resolvedModules.push(getResult(resolution));
            }

            // replace old results with a new one
            cache.set(path, newResolutions);
            return resolvedModules;

            function moduleResolutionIsValid(resolution: T): boolean {
                if (!resolution) {
                    return false;
                }

                const result = getResult(resolution);
                if (result) {
                    const resultFileName = getResultFileName(result);
                    if (resultFileName &&  resultFileName === lastDeletedFileName) {
                        return false;
                    }
                    return true;
                }

                // consider situation if we have no candidate locations as valid resolution.
                // after all there is no point to invalidate it if we have no idea where to look for the module.
                return resolution.failedLookupLocations.length === 0;
            }
        }

        getProjectVersion() {
            return this.project.getProjectVersion();
        }

        getCompilationSettings() {
            return this.compilationSettings;
        }

        useCaseSensitiveFileNames() {
            return this.host.useCaseSensitiveFileNames;
        }

        getCancellationToken() {
            return this.cancellationToken;
        }

        resolveTypeReferenceDirectives(typeDirectiveNames: string[], containingFile: string): ResolvedTypeReferenceDirective[] {
            return this.resolveNamesWithLocalCache(typeDirectiveNames, containingFile, this.resolvedTypeReferenceDirectives, resolveTypeReferenceDirective, m => m.resolvedTypeReferenceDirective, r => r.resolvedFileName);
        }

        resolveModuleNames(moduleNames: string[], containingFile: string): ResolvedModule[] {
            return this.resolveNamesWithLocalCache(moduleNames, containingFile, this.resolvedModuleNames, this.resolveModuleName, m => m.resolvedModule, resolvedPath);
        }

        getDefaultLibFileName() {
            const nodeModuleBinDir = getDirectoryPath(normalizePath(this.host.getExecutingFilePath()));
            return combinePaths(nodeModuleBinDir, getDefaultLibFileName(this.compilationSettings));
        }

        getScriptSnapshot(filename: string): ts.IScriptSnapshot {
            const scriptInfo = this.project.getScriptInfoLSHost(filename);
            if (scriptInfo) {
                return scriptInfo.snap();
            }
        }

        getScriptFileNames() {
            return this.project.getRootFilesLSHost();
        }

        getTypeRootsVersion() {
            return this.project.typesVersion;
        }

        getScriptKind(fileName: string) {
            const info = this.project.getScriptInfoLSHost(fileName);
            return info && info.scriptKind;
        }

        getScriptVersion(filename: string) {
            const info = this.project.getScriptInfoLSHost(filename);
            return info && info.getLatestVersion();
        }

        getCurrentDirectory(): string {
            return this.host.getCurrentDirectory();
        }

        resolvePath(path: string): string {
            return this.host.resolvePath(path);
        }

        fileExists(path: string): boolean {
            return this.host.fileExists(path);
        }

        readFile(fileName: string): string {
            return this.host.readFile(fileName);
        }

        directoryExists(path: string): boolean {
            return this.host.directoryExists(path);
        }

        readDirectory(path: string, extensions?: string[], exclude?: string[], include?: string[]): string[] {
            return this.host.readDirectory(path, extensions, exclude, include);
        }

        getDirectories(path: string): string[] {
            return this.host.getDirectories(path);
        }

        notifyFileRemoved(info: ScriptInfo) {
            this.resolvedModuleNames.remove(info.path);
            this.resolvedTypeReferenceDirectives.remove(info.path);
        }

        setCompilationSettings(opt: ts.CompilerOptions) {
            this.compilationSettings = opt;
            // conservatively assume that changing compiler options might affect module resolution strategy
            this.resolvedModuleNames.clear();
            this.resolvedTypeReferenceDirectives.clear();
        }
    }
}