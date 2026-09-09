import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import ts from "typescript";

export interface PolicyDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly rule: string;
  readonly message: string;
}

const excludedDirectories = new Set(["node_modules", ".git"]);
const outputDirectories = new Set(["dist", ".artifacts"]);
const nativeArtifactName = /\.(?:node|so(?:\.\d+)*|dll|dylib|a|o|obj|lib|exe)$/i;
const implementationExtensions = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".tsx", ".c", ".h", ".cc", ".cpp", ".cxx",
  ".hpp", ".m", ".mm", ".rs", ".go", ".py", ".wasm", ".wat", ".glsl", ".vert", ".frag",
]);
const retiredTestEnvironment = new Set(["QUAKE3_DATA", "QUAKE_DATA_PATH", "Q3_GL_TEST", "QUAKE_SDL_TEST_GL"]);

function hasNativeHeader(path: string): boolean {
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(8);
    const count = readSync(descriptor, header, 0, header.length, 0);
    if (count < 4) return false;
    const magic = header.readUInt32BE(0);
    return magic === 0x7f454c46 || header.readUInt16BE(0) === 0x4d5a
      || [0x0061736d, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)
      || header.toString("ascii", 0, count) === "!<arch>\n";
  } finally {
    closeSync(descriptor);
  }
}

function discoverFiles(root: string): string[] {
  const files: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (excludedDirectories.has(entry.name)) continue;
      if (directory === root && outputDirectories.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if ((entry.isFile() || entry.isSymbolicLink()) && (entry.name.endsWith(".ts")
        || implementationExtensions.has(extname(entry.name).toLowerCase()) || nativeArtifactName.test(entry.name) || hasNativeHeader(path))) files.push(path);
    }
  }
  visit(root);
  return files.sort();
}

function isTypeReference(type: ts.Type): type is ts.TypeReference {
  return (type.flags & ts.TypeFlags.Object) !== 0 && "objectFlags" in type
    && typeof type.objectFlags === "number" && (type.objectFlags & ts.ObjectFlags.Reference) !== 0;
}

function hasAny(type: ts.Type, checker: ts.TypeChecker, visited = new Set<ts.Type>()): boolean {
  if ((type.flags & ts.TypeFlags.Any) !== 0) return true;
  if (visited.has(type)) return false;
  visited.add(type);
  if (type.isUnionOrIntersection()) return type.types.some((part) => hasAny(part, checker, visited));
  if (isTypeReference(type) && checker.getTypeArguments(type).some((argument) => hasAny(argument, checker, visited))) return true;
  if (type.flags & ts.TypeFlags.Object) {
    for (const kind of [ts.IndexKind.Number, ts.IndexKind.String]) {
      const element = checker.getIndexTypeOfType(type, kind);
      if (element !== undefined && hasAny(element, checker, visited)) return true;
    }
    const awaited = checker.getAwaitedType(type);
    if (awaited !== undefined && awaited !== type) return hasAny(awaited, checker, visited);
  }
  return false;
}

function isUnknown(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Unknown) !== 0;
}

function containsPromise(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (type.isUnion()) return type.types.some(part => containsPromise(part, checker));
  const awaited = checker.getAwaitedType(type);
  return awaited !== undefined && awaited !== type;
}

function parameterDomainsMayOverlap(left: ts.Type, right: ts.Type, checker: ts.TypeChecker): boolean {
  if (checker.isTypeAssignableTo(left, right) || checker.isTypeAssignableTo(right, left)) return true;
  if (left.isUnion()) return left.types.some(part => parameterDomainsMayOverlap(part, right, checker));
  if (right.isUnion()) return right.types.some(part => parameterDomainsMayOverlap(left, part, checker));
  const primitiveDomains = [ts.TypeFlags.StringLike, ts.TypeFlags.NumberLike, ts.TypeFlags.BigIntLike,
    ts.TypeFlags.BooleanLike, ts.TypeFlags.ESSymbolLike, ts.TypeFlags.Null, ts.TypeFlags.Undefined | ts.TypeFlags.Void];
  const leftDomain = primitiveDomains.find(domain => (left.flags & domain) !== 0);
  const rightDomain = primitiveDomains.find(domain => (right.flags & domain) !== 0);
  if (leftDomain !== undefined && rightDomain !== undefined && leftDomain !== rightDomain) return false;
  const literal = ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BigIntLiteral | ts.TypeFlags.BooleanLiteral;
  if ((left.flags & literal) !== 0 && (right.flags & literal) !== 0
    && ((left.flags | right.flags) & ts.TypeFlags.EnumLike) === 0) return false;
  return true;
}

function canReceiveDestinationCall(actual: ts.Signature, expected: ts.Signature, checker: ts.TypeChecker, location: ts.Node): boolean {
  const declaration = actual.getDeclaration(), destination = expected.getDeclaration();
  if (declaration === undefined || destination === undefined) return true;
  const runtimeParameters = (parameters: readonly ts.ParameterDeclaration[]): readonly ts.ParameterDeclaration[] =>
    parameters.filter(parameter => !(ts.isIdentifier(parameter.name) && parameter.name.text === "this"));
  const sourceParameters = runtimeParameters(declaration.parameters), destinationParameters = runtimeParameters(destination.parameters);
  let required = 0;
  for (const [index, parameter] of sourceParameters.entries()) {
    if (parameter.dotDotDotToken === undefined && parameter.questionToken === undefined && parameter.initializer === undefined) required = index + 1;
  }
  if (!destinationParameters.some(parameter => parameter.dotDotDotToken !== undefined) && required > destinationParameters.length) return false;
  const sourceSymbols = actual.getParameters(), destinationSymbols = expected.getParameters();
  for (const [index, source] of sourceSymbols.entries()) {
    const target = destinationSymbols[index];
    if (target === undefined || sourceParameters[index]?.dotDotDotToken !== undefined || destinationParameters[index]?.dotDotDotToken !== undefined) continue;
    if (!parameterDomainsMayOverlap(checker.getTypeOfSymbolAtLocation(source, location), checker.getTypeOfSymbolAtLocation(target, location), checker)) return false;
  }
  return true;
}

/** TypeScript deliberately permits Promise-returning functions in void slots. */
function erasesAsyncReturn(actual: ts.Type, expected: ts.Type, checker: ts.TypeChecker, location: ts.Node,
  visited = new Map<ts.Type, Set<ts.Type>>()): boolean {
  if (actual === expected || (actual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return false;
  const destinations = expected.getCallSignatures();
  if (destinations.length > 0 && destinations.every(signature => (checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.Void) !== 0)
    && actual.getCallSignatures().some(signature => containsPromise(checker.getReturnTypeOfSignature(signature), checker)
      && destinations.some(destination => canReceiveDestinationCall(signature, destination, checker, location)))) return true;
  const prior = visited.get(actual);
  if (prior?.has(expected)) return false;
  if (prior === undefined) visited.set(actual, new Set([expected]));
  else prior.add(expected);
  if (expected.isUnion()) {
    const compatible = expected.types.filter(part => checker.isTypeAssignableTo(actual, part));
    return compatible.length > 0 && compatible.every(part => erasesAsyncReturn(actual, part, checker, location, visited));
  }
  if (actual.isUnion()) return actual.types.some(part => erasesAsyncReturn(part, expected, checker, location, visited));
  if ((actual.flags & ts.TypeFlags.Object) === 0 || (expected.flags & ts.TypeFlags.Object) === 0) return false;
  for (const kind of [ts.IndexKind.Number, ts.IndexKind.String]) {
    const from = checker.getIndexTypeOfType(actual, kind), to = checker.getIndexTypeOfType(expected, kind);
    if (from !== undefined && to !== undefined && erasesAsyncReturn(from, to, checker, location, visited)) return true;
  }
  for (const property of expected.getProperties()) {
    const from = checker.getPropertyOfType(actual, property.getName());
    if (from !== undefined && erasesAsyncReturn(checker.getTypeOfSymbolAtLocation(from, location),
      checker.getTypeOfSymbolAtLocation(property, location), checker, location, visited)) return true;
  }
  return false;
}

function isUnknownBoundary(node: ts.Node, checker: ts.TypeChecker): boolean {
  let value = node;
  while (ts.isParenthesizedExpression(value.parent) || ts.isAwaitExpression(value.parent)) value = value.parent;
  const parent = value.parent;
  if ((ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isParameter(parent))
    && parent.initializer === value && parent.type !== undefined) {
    return isUnknown(checker.getTypeFromTypeNode(parent.type));
  }
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === value) {
    return isUnknown(checker.getTypeAtLocation(parent.left));
  }
  return false;
}

function referenceSymbol(node: ts.Expression, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (ts.isParenthesizedExpression(node)) return referenceSymbol(node.expression, checker);
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  return symbol;
}

function isDynamicImplementation(symbol: ts.Symbol | undefined): boolean {
  const name = symbol?.getName();
  return (name === "eval" || name === "Function" || name === "WebAssembly")
    && (symbol?.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile) ?? false);
}

function platformLibrary(node: ts.Expression | undefined): "sdl" | "gl" | "unix" | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteralLike(node)) {
    if (["libSDL2-2.0.so.0", "libSDL2.so", "libSDL2.dylib", "libSDL2-2.0.0.dylib", "SDL2.dll"].includes(node.text)) return "sdl";
    if (["libGL.so", "libGL.so.1", "opengl32.dll", "/System/Library/Frameworks/OpenGL.framework/OpenGL"].includes(node.text)) return "gl";
    if (node.text === "libc.so.6") return "unix";
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    && ts.isElementAccessExpression(node.left) && ts.isStringLiteralLike(node.left.argumentExpression)
    && node.left.argumentExpression.text === "QUAKE_SDL2_LIBRARY" && ts.isPropertyAccessExpression(node.left.expression)
    && node.left.expression.name.text === "env" && ts.isIdentifier(node.left.expression.expression)
    && node.left.expression.expression.text === "process" && platformLibrary(node.right) === "sdl") return "sdl";
  return undefined;
}

export function auditProgram(program: ts.Program, projectFiles: readonly string[], projectRoot = program.getCurrentDirectory()): PolicyDiagnostic[] {
  const checker = program.getTypeChecker();
  const files = new Set(projectFiles.map((file) => resolve(file)));
  const diagnostics: PolicyDiagnostic[] = [];
  for (const source of program.getSourceFiles()) {
    if (!files.has(resolve(source.fileName))) continue;
    const projectPath = relative(resolve(projectRoot), resolve(source.fileName)).replaceAll("\\", "/");
    const runtime = projectPath.startsWith("src/");
    const platform = projectPath.startsWith("src/platform/");
    const seen = new Set<string>();
    function report(node: ts.Node, rule: string, message: string, position = node.getStart(source)): void {
      const key = `${position}:${rule}`;
      if (seen.has(key)) return;
      seen.add(key);
      const location = source.getLineAndCharacterOfPosition(position);
      diagnostics.push({ file: resolve(source.fileName), line: location.line + 1, column: location.character + 1, rule, message });
    }
    if (source.isDeclarationFile) report(source, "ambient", "Project declaration files can hide implementation; use checked TypeScript definitions.", 0);
    function moduleBoundary(node: ts.Node, moduleName: string): void {
      if (nativeArtifactName.test(moduleName.replace(/[?#].*$/, ""))) report(node, "native-implementation", "Native addons and libraries cannot be project modules; use the SDL2/OpenGL platform boundary.");
      if (moduleName === "bun:ffi" && !platform) report(node, "ffi-boundary", "Only src/platform modules may import bun:ffi.");
      if (!runtime) return;
      const builtin = moduleName.replace(/^node:/, "");
      if (["child_process", "cluster", "module"].includes(builtin)) report(node, "runtime-subprocess", "Runtime modules cannot load subprocess or CommonJS loader APIs; subprocess orchestration belongs in tools/tests.");
      const resolved = ts.resolveModuleName(moduleName, source.fileName, program.getCompilerOptions(), ts.sys).resolvedModule?.resolvedFileName;
      const local = resolved ?? (moduleName.startsWith(".") ? resolve(dirname(source.fileName), moduleName) : undefined);
      if (local !== undefined) {
        const imported = relative(resolve(projectRoot), local).replaceAll("\\", "/");
        if (!imported.startsWith("src/") && !imported.startsWith("node_modules/")) report(node, "runtime-boundary", "Local runtime imports must stay within src; build tools, tests, and generated artifacts cannot implement runtime behavior.");
      }
    }
    function nativeReference(node: ts.Node, symbol: ts.Symbol | undefined): void {
      const name = symbol?.getName();
      const declarations = symbol?.declarations ?? [];
      const bun = declarations.some((declaration) => /\/(?:bun-types|@types\/bun)\//.test(declaration.getSourceFile().fileName.replaceAll("\\", "/")));
      const nodeBuiltin = declarations.some((declaration) => /\/@types\/node\//.test(declaration.getSourceFile().fileName.replaceAll("\\", "/")));
      if ((bun || nodeBuiltin) && ["require", "createRequire", "binding", "_linkedBinding", "getBuiltinModule"].includes(name ?? "")) {
        report(node, "native-loader", "CommonJS and internal native loaders are forbidden; use checked TypeScript imports.");
      }
      if (nodeBuiltin && name === "dlopen") report(node, "native-loader", "process.dlopen can load native addons and is forbidden.");
      if (bun && name === "cc") report(node, "native-implementation", "Bun's C compiler cannot implement project behavior.");
      if (bun && (name === "dlopen" || name === "linkSymbols")) {
        const expression = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
        if (!ts.isImportSpecifier(node.parent) && !(ts.isCallExpression(expression.parent) && expression.parent.expression === expression)) {
          report(node, "ffi-binding", "FFI loaders must be called directly with visible system platform descriptors; do not alias or export them.");
        }
      }
      if (runtime && ((bun && ["spawn", "spawnSync", "$"].includes(name ?? ""))
        || (nodeBuiltin && ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "execve", "fork"].includes(name ?? "")))) {
        report(node, "runtime-subprocess", "Runtime modules cannot execute external programs or compiler output; subprocess orchestration belongs in tools/tests.");
      }
    }
    function ffiCall(node: ts.CallExpression): void {
      const symbol = referenceSymbol(node.expression, checker);
      if (!symbol?.declarations?.some((declaration) => /\/bun-types\/ffi\.d\.ts$/.test(declaration.getSourceFile().fileName.replaceAll("\\", "/")))) return;
      const name = symbol.getName();
      if (name !== "dlopen" && name !== "linkSymbols") return;
      if (!platform) report(node, "ffi-boundary", "Only src/platform modules may call FFI loaders, including re-exported loaders.");
      const library = name === "dlopen" ? platformLibrary(node.arguments[0]) : "gl";
      if (library === undefined) report(node, "ffi-library", "FFI may load only named system SDL2/OpenGL libraries or approved libc platform services, with the existing QUAKE_SDL2_LIBRARY override.");
      const descriptors = node.arguments[name === "dlopen" ? 1 : 0];
      if (descriptors === undefined || !ts.isObjectLiteralExpression(descriptors)) {
        report(node, "ffi-symbol", "FFI requires a visible object of system platform symbol descriptors.");
        return;
      }
      for (const property of descriptors.properties) {
        const key = property.name;
        const text = key !== undefined && (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) ? key.text : undefined;
        if (!ts.isPropertyAssignment(property) || text === undefined
          || !(library === "sdl" ? /^SDL_/.test(text) && !["SDL_LoadObject", "SDL_LoadFunction", "SDL_UnloadObject"].includes(text)
            : library === "unix" ? ["tcgetattr", "tcsetattr", "sigaction", "localtime_r", "tzset", "_exit"].includes(text) : library === "gl" && /^gl[A-Z]/.test(text))) {
          report(property, "ffi-symbol", "FFI symbols must belong to the selected SDL2/OpenGL API or the explicit Unix platform allowlist; native module loading and opaque descriptors are forbidden.");
        }
      }
    }
    function comments(node: ts.Node): void {
      const ranges = [...ts.getLeadingCommentRanges(source.text, node.pos) ?? [], ...ts.getTrailingCommentRanges(source.text, node.end) ?? []];
      for (const range of ranges) {
        const text = source.text.slice(range.pos, range.end);
        if (/@ts-(?:ignore|expect-error|nocheck)\b/.test(text)) report(node, "suppression", "TypeScript diagnostic suppression is forbidden.", range.pos);
      }
    }
    function visit(node: ts.Node): void {
      comments(node);
      if (projectPath.startsWith("tests/") && (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node))
        && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "env"
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "process") {
        const key = ts.isElementAccessExpression(node) ? node.argumentExpression : node.name;
        if (ts.isStringLiteralLike(key) || ts.isIdentifier(key)) {
          const type = checker.getTypeAtLocation(key);
          const name = ts.isPropertyAccessExpression(node) ? key.text : type.isStringLiteral() ? type.value : undefined;
          if (name !== undefined && retiredTestEnvironment.has(name)) report(node, "test-environment", "Tests must use Q3_DATA and QUAKE_GL_TEST so the full check cannot silently omit retail or OpenGL coverage.");
        }
      }
      if (ts.isExpression(node) && !ts.isPartOfTypeNode(node)) {
        const expected = checker.getContextualType(node);
        if (expected !== undefined && erasesAsyncReturn(checker.getTypeAtLocation(node), expected, checker, node)) {
          report(node, "async-void", "A synchronous void contract cannot accept asynchronous work; expose and await the Promise or provide a synchronous implementation.");
        }
      }
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        for (const clause of node.heritageClauses ?? []) for (const base of clause.types) {
          if (erasesAsyncReturn(checker.getTypeAtLocation(node), checker.getTypeAtLocation(base), checker, node)) {
            report(node, "async-void", "A synchronous void contract cannot accept asynchronous work; expose and await the Promise or provide a synchronous implementation.");
          }
        }
      }
      if (node.kind === ts.SyntaxKind.AnyKeyword) report(node, "explicit-any", "Explicit any is forbidden; narrow unknown at the boundary.");
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) report(node, "assertion", "Type assertions, including const assertions, are forbidden.");
      if (ts.isNonNullExpression(node)) report(node, "non-null", "Non-null assertions are forbidden; check the value.");
      if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.exclamationToken !== undefined) report(node, "definite-assignment", "Definite-assignment assertions are forbidden; initialize owned state.");
      if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) report(node, "ambient", "Project ambient declarations are forbidden.");
      if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) || ts.isPropertyDeclaration(node)) {
        if (hasAny(checker.getTypeAtLocation(node.name), checker)) report(node.name, "unsafe-any", "Binding has unsafe any, including array or promise elements; use an explicit unknown boundary.");
        if (node.initializer !== undefined && hasAny(checker.getTypeAtLocation(node.initializer), checker)
          && !isUnknownBoundary(node.initializer, checker)) report(node.initializer, "unsafe-assignment", "Unsafe any cannot initialize a typed destination.");
      }
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name;
        if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) nativeReference(node, checker.getPropertyOfType(checker.getTypeAtLocation(node.parent), key.text));
      }
      if ((ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && !ts.isPartOfTypeNode(node)) {
        if (hasAny(checker.getTypeAtLocation(node), checker) && !isUnknownBoundary(node, checker)) report(node, "unsafe-any", "Expression exposes unsafe any; bind external data directly to explicit unknown before use.");
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && hasAny(checker.getTypeAtLocation(node.right), checker) && !isUnknown(checker.getTypeAtLocation(node.left))) {
        report(node.right, "unsafe-assignment", "Unsafe any cannot be assigned to a typed destination.");
      }
      if (ts.isIdentifier(node) && !ts.isPartOfTypeNode(node)) {
        if (isDynamicImplementation(referenceSymbol(node, checker))) report(node, "dynamic-implementation", "Dynamic JavaScript and WebAssembly implementations are forbidden.");
        nativeReference(node, referenceSymbol(node, checker));
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        if (ts.isCallExpression(node)) ffiCall(node);
        for (const argument of node.arguments ?? []) {
          if (hasAny(checker.getTypeAtLocation(argument), checker)) report(argument, "unsafe-argument", "Bind unsafe any to unknown and validate it before passing it to a function.");
        }
      }
      if (ts.isReturnStatement(node) && node.expression !== undefined && hasAny(checker.getTypeAtLocation(node.expression), checker)) {
        report(node.expression, "unsafe-return", "Bind unsafe any to unknown and validate it before returning it.");
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const moduleName = node.moduleSpecifier.text;
        moduleBoundary(node, moduleName);
        if (moduleName === "bun:ffi") {
          const bindings = node.importClause?.namedBindings;
          if (bindings === undefined || !ts.isNamedImports(bindings) || node.importClause?.name !== undefined) report(node, "ffi-binding", "Use named bun:ffi imports so platform loader calls remain statically visible.");
          if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const binding of bindings.elements) {
              if ((binding.propertyName ?? binding.name).text === "cc") report(binding, "native-implementation", "Bun's C compiler cannot implement project behavior.");
            }
          }
        }
      }
      if (ts.isPropertyAccessExpression(node) && node.name.text === "cc") {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol?.declarations?.some((declaration) => declaration.getSourceFile().fileName.includes("bun"))) report(node, "native-implementation", "Bun's C compiler cannot implement project behavior.");
      }
      if (ts.isElementAccessExpression(node)) {
        const key = checker.getTypeAtLocation(node.argumentExpression);
        for (const part of key.isUnion() ? key.types : [key]) {
          if (!part.isStringLiteral()) continue;
          const symbol = checker.getPropertyOfType(checker.getTypeAtLocation(node.expression), part.value);
          nativeReference(node, symbol);
          if (isDynamicImplementation(symbol)) report(node, "dynamic-implementation", "Dynamic JavaScript and WebAssembly implementations are forbidden.");
        }
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const moduleName = node.arguments[0];
        if (moduleName !== undefined) {
          const type = checker.getTypeAtLocation(moduleName);
          const values = type.isUnion() ? type.types : [type];
          for (const value of values) {
            if (!value.isStringLiteral()) {
              if (runtime) report(node, "runtime-boundary", "Runtime dynamic imports require statically known module names so native and tool boundaries can be checked.");
              continue;
            }
            moduleBoundary(node, value.value);
            if (value.value === "bun:ffi") report(node, "ffi-binding", "Use named bun:ffi imports so platform loader calls remain statically visible.");
          }
        }
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
        moduleBoundary(node, node.moduleSpecifier.text);
        if (node.moduleSpecifier.text === "bun:ffi") report(node, "ffi-binding", "Do not re-export bun:ffi; expose owned platform services instead.");
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
        && node.moduleReference.expression !== undefined && ts.isStringLiteralLike(node.moduleReference.expression)) moduleBoundary(node, node.moduleReference.expression.text);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
}

export function auditProject(root: string): PolicyDiagnostic[] {
  const projectRoot = resolve(root);
  const files = discoverFiles(projectRoot);
  const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, "tsconfig.json");
  if (configPath === undefined) throw new Error(`No tsconfig.json found in ${projectRoot}`);
  const configuration = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configuration.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(configuration.error.messageText, "\n"));
  const rawConfiguration: unknown = configuration.config;
  const parsed = ts.parseJsonConfigFileContent(rawConfiguration, ts.sys, projectRoot);
  if (parsed.errors.length !== 0) throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
  const typescriptFiles = files.filter((file) => file.endsWith(".ts"));
  const program = ts.createProgram(typescriptFiles, parsed.options);
  const diagnostics = auditProgram(program, typescriptFiles, projectRoot);
  for (const file of files) {
    if (!file.endsWith(".ts") || hasNativeHeader(file)) diagnostics.push({ file, line: 1, column: 1, rule: "implementation-language", message: "Project implementation must be .ts; native sources/binaries, JavaScript, shader and WASM artifacts are forbidden." });
  }
  return diagnostics;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? process.cwd());
  try {
    const diagnostics = auditProject(root);
    for (const diagnostic of diagnostics) process.stderr.write(`${relative(root, diagnostic.file)}:${diagnostic.line}:${diagnostic.column} [${diagnostic.rule}] ${diagnostic.message}\n`);
    if (diagnostics.length === 0) process.stdout.write("TypeScript policy passed.\n");
    process.exitCode = diagnostics.length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`TypeScript policy failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
