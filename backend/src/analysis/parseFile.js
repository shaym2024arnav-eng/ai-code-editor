// Extracts the "facts" of one JS/TS file: imports, exports, functions, calls,
// Express routes, HTTP client calls and data models. Everything here is per-file;
// buildGraph.js connects the facts across files.
const { parse } = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const { extensionOf } = require("../ingest/filters");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "options", "head"]);
const ROUTER_OBJECT_RE = /^(app|server|router|api|routes?)$|router$|routes?$/i;
const CLIENT_OBJECT_RE = /^(axios|api|http|client|instance|request|ky|superagent)$|axios|api|http|client/i;

function pluginsFor(filePath) {
  const ext = extensionOf(filePath);
  if (ext === ".ts") return ["typescript", "decorators-legacy"];
  if (ext === ".tsx") return ["typescript", "jsx", "decorators-legacy"];
  return ["jsx", "decorators-legacy"];
}

const languageOf = (filePath) => {
  const ext = extensionOf(filePath);
  return ext === ".ts" || ext === ".tsx" ? "typescript" : "javascript";
};

const keyName = (key) => {
  if (!key) return null;
  if (key.type === "Identifier") return key.name;
  if (key.type === "StringLiteral") return key.value;
  if (key.type === "PrivateName") return `#${key.id.name}`;
  return null;
};

const isMember = (node, objectName, propName) =>
  node &&
  (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
  !node.computed &&
  node.object.type === "Identifier" &&
  node.object.name === objectName &&
  node.property.type === "Identifier" &&
  node.property.name === propName;

// exports.X = ... / module.exports.X = ...  -> "X"
function commonJsExportName(left) {
  if (!left || left.type !== "MemberExpression" || left.computed) return null;
  if (left.property.type !== "Identifier") return null;
  if (left.object.type === "Identifier" && left.object.name === "exports") return left.property.name;
  if (isMember(left.object, "module", "exports")) return left.property.name;
  return null;
}

const isModuleExports = (left) => isMember(left, "module", "exports");

const stringValue = (node) => {
  if (!node) return null;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
};

// Describe a callee as { name } or { object, property } (object "@this" for this.x()).
function describeCallee(callee) {
  if (!callee) return null;
  if (callee.type === "Identifier") return { name: callee.name };
  if ((callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") && !callee.computed) {
    const prop = callee.property.type === "Identifier" ? callee.property.name : null;
    if (!prop) return null;
    if (callee.object.type === "Identifier") return { object: callee.object.name, property: prop };
    if (callee.object.type === "ThisExpression") return { object: "@this", property: prop };
  }
  return null;
}

// Turn a URL expression into parts: { text } | { ident } | { env } | { param }.
function urlParts(node, depth = 0) {
  if (!node || depth > 6) return null;
  switch (node.type) {
    case "StringLiteral":
      return [{ text: node.value }];
    case "TemplateLiteral": {
      const parts = [];
      node.quasis.forEach((q, i) => {
        if (q.value.cooked) parts.push({ text: q.value.cooked });
        const expr = node.expressions[i];
        if (expr) parts.push(...(expressionPart(expr, depth) || [{ param: true }]));
      });
      return parts;
    }
    case "BinaryExpression": {
      if (node.operator !== "+") return null;
      const left = urlParts(node.left, depth + 1) || expressionPart(node.left, depth);
      const right = urlParts(node.right, depth + 1) || expressionPart(node.right, depth);
      return left && right ? [...left, ...right] : null;
    }
    case "Identifier":
      return [{ ident: node.name }];
    default:
      return null;
  }
}

function expressionPart(expr, depth) {
  if (expr.type === "Identifier") return [{ ident: expr.name }];
  if (expr.type === "MemberExpression" && !expr.computed && expr.property.type === "Identifier") {
    // import.meta.env.VITE_API_URL or process.env.API_URL
    const obj = expr.object;
    if (obj.type === "MemberExpression" && obj.property.type === "Identifier" && obj.property.name === "env") {
      return [{ env: expr.property.name }];
    }
  }
  if (expr.type === "StringLiteral" || expr.type === "TemplateLiteral" || expr.type === "BinaryExpression") {
    return urlParts(expr, depth + 1);
  }
  return null;
}

// Value of a top-level constant: string parts, or a fallback inside `A || "x"`.
function constParts(init) {
  if (!init) return null;
  if (init.type === "LogicalExpression" && (init.operator === "||" || init.operator === "??")) {
    const right = urlParts(init.right);
    if (right && right.every((p) => p.text !== undefined || p.ident)) return right;
    return urlParts(init.left);
  }
  if (init.type === "ConditionalExpression") return urlParts(init.alternate) || urlParts(init.consequent);
  if (["StringLiteral", "TemplateLiteral", "BinaryExpression"].includes(init.type)) return urlParts(init);
  return null;
}

function parseFile(filePath, content) {
  const facts = {
    path: filePath,
    language: languageOf(filePath),
    lines: content.split("\n").length,
    imports: [],
    exports: [],
    functions: [],
    calls: [], // { caller, name? , object?, property?, line }
    routes: [], // { method, path, handlers: [callee], line }
    mounts: [], // { prefix, local? , source? , line }
    requests: [], // { caller, method, parts, line }
    models: [], // { name, line }
    consts: {}, // name -> url parts (top-level string constants)
    error: null,
  };

  let ast;
  try {
    ast = parse(content, {
      sourceType: "unambiguous",
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      plugins: pluginsFor(filePath),
    });
  } catch (err) {
    facts.error = err.message.split("\n")[0];
    return facts;
  }
  if (ast.errors && ast.errors.length) facts.error = ast.errors[0].message.split("\n")[0];

  const fnNames = new WeakMap(); // function AST node -> recorded name
  const usedNames = new Map();
  const uniqueName = (name) => {
    const n = (usedNames.get(name) || 0) + 1;
    usedNames.set(name, n);
    return n === 1 ? name : `${name}#${n}`;
  };

  const line = (node) => (node && node.loc ? node.loc.start.line : null);

  function recordFunction(fnPath, name, kind, { exported = false } = {}) {
    const node = fnPath.node;
    const finalName = uniqueName(name);
    fnNames.set(node, finalName);
    facts.functions.push({
      name: finalName,
      kind,
      startLine: line(node),
      endLine: node.loc ? node.loc.end.line : null,
      lines: node.loc ? node.loc.end.line - node.loc.start.line + 1 : 0,
      async: Boolean(node.async),
      params: node.params ? node.params.length : 0,
      exported,
    });
    return finalName;
  }

  // The name of the nearest named function around a path, or "(module)".
  function enclosingFunction(path) {
    let p = path.parentPath;
    while (p) {
      if (fnNames.has(p.node)) return fnNames.get(p.node);
      p = p.parentPath;
    }
    return "(module)";
  }

  const addExport = (name, local = name) => {
    if (!facts.exports.some((e) => e.name === name)) facts.exports.push({ name, local });
  };

  // Is this call `router.get("/x", ...)`? Returns route info or null.
  function routeInfo(node) {
    const callee = node.callee;
    if (callee.type !== "MemberExpression" || callee.computed || callee.object.type !== "Identifier") return null;
    if (callee.property.type !== "Identifier") return null;
    const method = callee.property.name.toLowerCase();
    if (!HTTP_METHODS.has(method) || !ROUTER_OBJECT_RE.test(callee.object.name)) return null;
    const routePath = stringValue(node.arguments[0]);
    if (routePath === null || !routePath.startsWith("/")) return null;
    if (node.arguments.length < 2) return null; // app.get("/x") with no handler is a config getter
    return { method: method.toUpperCase(), path: routePath };
  }

  // Name functions before visiting calls inside them.
  traverse(ast, {
    // Imports -------------------------------------------------------------
    ImportDeclaration(path) {
      const n = path.node;
      facts.imports.push({
        source: n.source.value,
        kind: "import",
        typeOnly: n.importKind === "type",
        line: line(n),
        specifiers: n.specifiers.map((s) => {
          if (s.type === "ImportDefaultSpecifier") return { imported: "default", local: s.local.name };
          if (s.type === "ImportNamespaceSpecifier") return { imported: "*", local: s.local.name };
          return { imported: keyName(s.imported), local: s.local.name };
        }),
      });
    },

    ExportNamedDeclaration(path) {
      const n = path.node;
      if (n.source) {
        facts.imports.push({
          source: n.source.value,
          kind: "reexport",
          typeOnly: n.exportKind === "type",
          line: line(n),
          specifiers: n.specifiers.map((s) => ({
            imported: s.type === "ExportNamespaceSpecifier" ? "*" : keyName(s.local),
            local: keyName(s.exported),
            reexport: true,
          })),
        });
        n.specifiers.forEach((s) => addExport(keyName(s.exported), `@reexport:${n.source.value}:${s.type === "ExportNamespaceSpecifier" ? "*" : keyName(s.local)}`));
        return;
      }
      const d = n.declaration;
      if (d) {
        if ((d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") && d.id) addExport(d.id.name);
        if (d.type === "VariableDeclaration") {
          d.declarations.forEach((v) => v.id.type === "Identifier" && addExport(v.id.name));
        }
        if ((d.type === "TSInterfaceDeclaration" || d.type === "TSTypeAliasDeclaration" || d.type === "TSEnumDeclaration") && d.id) {
          addExport(d.id.name);
        }
      }
      n.specifiers.forEach((s) => addExport(keyName(s.exported), keyName(s.local)));
    },

    ExportAllDeclaration(path) {
      const n = path.node;
      facts.imports.push({
        source: n.source.value,
        kind: "reexport",
        typeOnly: n.exportKind === "type",
        line: line(n),
        specifiers: [{ imported: "*", local: "*", reexport: true, all: true }],
      });
    },

    ExportDefaultDeclaration(path) {
      const d = path.node.declaration;
      if ((d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") && d.id) addExport("default", d.id.name);
      else if (d.type === "Identifier") addExport("default", d.name);
      else addExport("default", "default");
    },

    // Functions -----------------------------------------------------------
    FunctionDeclaration(path) {
      if (!path.node.id) {
        if (path.parent.type === "ExportDefaultDeclaration") recordFunction(path, "default", "function", { exported: true });
        return;
      }
      recordFunction(path, path.node.id.name, "function");
    },

    "ArrowFunctionExpression|FunctionExpression"(path) {
      if (fnNames.has(path.node)) return;
      const parent = path.parent;

      if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier") {
        return void recordFunction(path, parent.id.name, path.isArrowFunctionExpression() ? "arrow" : "function");
      }
      // const Comp = memo(() => ...), const h = asyncHandler(async () => ...)
      // Only for wrapper calls like memo(fn) or React.memo(fn), not items.map(fn).
      const wrapperCallee = parent.type === "CallExpression" && (
        parent.callee.type === "Identifier" ||
        (parent.callee.type === "MemberExpression" && parent.callee.object.type === "Identifier" &&
          parent.callee.object.name === "React")
      );
      if (wrapperCallee && path.parentPath.parent.type === "VariableDeclarator") {
        const decl = path.parentPath.parent;
        if (decl.id.type === "Identifier" && parent.arguments[0] === path.node) {
          return void recordFunction(path, decl.id.name, "arrow");
        }
      }
      if (parent.type === "AssignmentExpression") {
        const exportName = commonJsExportName(parent.left);
        if (exportName) return void recordFunction(path, exportName, "function", { exported: true });
        if (isModuleExports(parent.left)) return void recordFunction(path, "default", "function", { exported: true });
      }
      if (parent.type === "ExportDefaultDeclaration") {
        return void recordFunction(path, "default", "arrow", { exported: true });
      }
      if (parent.type === "ObjectProperty" && path.parentPath.parentPath.parent.type === "AssignmentExpression" &&
          isModuleExports(path.parentPath.parentPath.parent.left)) {
        const name = keyName(parent.key);
        if (name) return void recordFunction(path, name, "function", { exported: true });
      }
      if ((parent.type === "ClassProperty" || parent.type === "ClassPrivateProperty") && path.parentPath.parentPath.parentPath) {
        const cls = path.parentPath.parentPath.parent;
        const name = keyName(parent.key);
        if (name && cls.id) return void recordFunction(path, `${cls.id.name}.${name}`, "method");
      }
      // Inline Express handler: router.post("/upload", async (req, res) => {...})
      if (parent.type === "CallExpression") {
        const info = routeInfo(parent);
        if (info && parent.arguments.indexOf(path.node) > 0) {
          return void recordFunction(path, `${info.method} ${info.path}`, "handler");
        }
      }
    },

    "ClassMethod|ClassPrivateMethod"(path) {
      const cls = path.parentPath.parent;
      const name = keyName(path.node.key);
      if (!name) return;
      const className = cls.id ? cls.id.name : "AnonymousClass";
      recordFunction(path, `${className}.${name}`, "method");
    },

    ObjectMethod(path) {
      const objPath = path.parentPath;
      const assign = objPath.parent;
      if (assign.type === "AssignmentExpression" && isModuleExports(assign.left)) {
        const name = keyName(path.node.key);
        if (name && !fnNames.has(path.node)) recordFunction(path, name, "function", { exported: true });
      }
    },

    ClassDeclaration(path) {
      if (path.node.id) {
        facts.functions.push({
          name: uniqueName(path.node.id.name),
          kind: "class",
          startLine: line(path.node),
          endLine: path.node.loc ? path.node.loc.end.line : null,
          lines: path.node.loc ? path.node.loc.end.line - path.node.loc.start.line + 1 : 0,
          async: false,
          params: 0,
          exported: false,
        });
      }
    },
  });

  // Second pass: calls, require(), routes, requests, models, CommonJS exports.
  traverse(ast, {
    VariableDeclarator(path) {
      // Top-level string constants (used to resolve API base URLs).
      if (path.parentPath.parent.type === "Program" ||
          (path.parentPath.parent.type === "ExportNamedDeclaration" && path.parentPath.parentPath.parent.type === "Program")) {
        if (path.node.id.type === "Identifier") {
          const parts = constParts(path.node.init);
          if (parts) facts.consts[path.node.id.name] = parts;
        }
      }
    },

    AssignmentExpression(path) {
      const { left, right } = path.node;
      const exportName = commonJsExportName(left);
      if (exportName) addExport(exportName, right.type === "Identifier" ? right.name : exportName);
      if (isModuleExports(left)) {
        if (right.type === "Identifier") addExport("default", right.name);
        else if (right.type === "ObjectExpression") {
          addExport("default", "default");
          right.properties.forEach((p) => {
            if (p.type === "ObjectProperty") {
              const name = keyName(p.key);
              if (name) addExport(name, p.value.type === "Identifier" ? p.value.name : name);
            } else if (p.type === "ObjectMethod") {
              const name = keyName(p.key);
              if (name) addExport(name, name);
            }
          });
        } else addExport("default", "default");
      }
    },

    "CallExpression|OptionalCallExpression|NewExpression"(path) {
      const node = path.node;
      const callee = node.callee;

      // require("x")
      if (callee.type === "Identifier" && callee.name === "require" && node.arguments.length === 1) {
        const source = stringValue(node.arguments[0]);
        if (source === null) return;
        const parent = path.parent;
        const specifiers = [];
        if (parent.type === "VariableDeclarator") {
          if (parent.id.type === "Identifier") specifiers.push({ imported: "module", local: parent.id.name });
          if (parent.id.type === "ObjectPattern") {
            parent.id.properties.forEach((p) => {
              if (p.type === "ObjectProperty" && p.value.type === "Identifier") {
                specifiers.push({ imported: keyName(p.key), local: p.value.name });
              }
            });
          }
        } else if (parent.type === "MemberExpression" && !parent.computed && parent.property.type === "Identifier" &&
                   path.parentPath.parent.type === "VariableDeclarator" && path.parentPath.parent.id.type === "Identifier") {
          specifiers.push({ imported: parent.property.name, local: path.parentPath.parent.id.name });
        }
        facts.imports.push({ source, kind: "require", typeOnly: false, line: line(node), specifiers });
        return;
      }

      // import("x")
      if (callee.type === "Import") {
        const source = stringValue(node.arguments[0]);
        if (source !== null) facts.imports.push({ source, kind: "dynamic", typeOnly: false, line: line(node), specifiers: [] });
        return;
      }

      const caller = enclosingFunction(path);

      // Express routes and mounts
      if (node.type === "CallExpression") {
        const info = routeInfo(node);
        if (info) {
          const handlers = node.arguments.slice(1).map((arg) => {
            if (arg.type === "ArrowFunctionExpression" || arg.type === "FunctionExpression") {
              return fnNames.has(arg) ? { name: fnNames.get(arg), inline: true } : null;
            }
            return describeCallee(arg);
          }).filter(Boolean);
          facts.routes.push({ ...info, handlers, line: line(node) });
          return;
        }

        if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier" &&
            callee.property.name === "use" && callee.object.type === "Identifier" && ROUTER_OBJECT_RE.test(callee.object.name)) {
          const prefix = stringValue(node.arguments[0]);
          const targets = node.arguments.slice(prefix === null ? 0 : 1);
          targets.forEach((arg) => {
            if (arg.type === "Identifier") facts.mounts.push({ prefix: prefix || "", local: arg.name, line: line(node) });
            if (arg.type === "CallExpression" && arg.callee.type === "Identifier" && arg.callee.name === "require") {
              const source = stringValue(arg.arguments[0]);
              if (source) facts.mounts.push({ prefix: prefix || "", source, line: line(node) });
            }
          });
        }
      }

      // HTTP client calls: fetch(url), axios.get(url), api.post(url)
      if (node.type !== "NewExpression") {
        let method = null;
        let urlNode = null;
        if (callee.type === "Identifier" && callee.name === "fetch") {
          urlNode = node.arguments[0];
          method = "GET";
          const opts = node.arguments[1];
          if (opts && opts.type === "ObjectExpression") {
            const m = opts.properties.find((p) => p.type === "ObjectProperty" && keyName(p.key) === "method");
            const val = m && stringValue(m.value);
            if (val) method = val.toUpperCase();
          }
        } else if (callee.type === "MemberExpression" && !callee.computed && callee.object.type === "Identifier" &&
                   callee.property.type === "Identifier" && CLIENT_OBJECT_RE.test(callee.object.name) &&
                   HTTP_METHODS.has(callee.property.name.toLowerCase())) {
          const second = node.arguments[1];
          const looksLikeHandler = second && (second.type === "ArrowFunctionExpression" || second.type === "FunctionExpression");
          if (!looksLikeHandler) {
            urlNode = node.arguments[0];
            method = callee.property.name.toUpperCase();
          }
        }
        if (urlNode) {
          const parts = urlParts(urlNode);
          const hasPath = parts && parts.some((p) => p.text && (p.text.includes("/") || /^https?:/.test(p.text)));
          const fromConst = parts && parts[0] && parts[0].ident;
          if (parts && (hasPath || fromConst)) {
            facts.requests.push({ caller, method, parts, line: line(node) });
          }
        }
      }

      // Data models: mongoose.model("User", schema), model("User"), sequelize.define("User")
      const first = stringValue(node.arguments[0]);
      if (first && /^[A-Z][A-Za-z0-9_]*$/.test(first)) {
        const isMongooseModel =
          (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier" &&
            callee.property.name === "model" && node.arguments.length >= 2) ||
          (callee.type === "Identifier" && callee.name === "model" && node.arguments.length >= 2);
        const isSequelize = callee.type === "MemberExpression" && !callee.computed &&
          callee.property.type === "Identifier" && callee.property.name === "define" &&
          callee.object.type === "Identifier" && /sequelize|db/i.test(callee.object.name);
        if ((isMongooseModel || isSequelize) && !facts.models.some((m) => m.name === first)) {
          facts.models.push({ name: first, line: line(node) });
        }
      }

      const target = describeCallee(callee);
      if (target && !(target.name === "require")) {
        facts.calls.push({ caller, ...target, line: line(node) });
      }
    },

    JSXOpeningElement(path) {
      const n = path.node.name;
      if (n.type === "JSXIdentifier" && /^[A-Z]/.test(n.name)) {
        facts.calls.push({ caller: enclosingFunction(path), name: n.name, jsx: true, line: line(path.node) });
      } else if (n.type === "JSXMemberExpression" && n.object.type === "JSXIdentifier") {
        facts.calls.push({ caller: enclosingFunction(path), object: n.object.name, property: n.property.name, jsx: true, line: line(path.node) });
      }
    },
  });

  // Mark functions that are exported.
  const exportedLocals = new Set(facts.exports.map((e) => e.local));
  facts.functions.forEach((f) => {
    if (exportedLocals.has(f.name)) f.exported = true;
  });

  return facts;
}

module.exports = { parseFile, languageOf };
