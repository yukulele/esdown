import { parse, AST } from "esparse";
import { isLegacyScheme, removeScheme } from "./Schema.js";

const NODE_SCHEME = /^node:/i,
      URI_SCHEME = /^[a-z]+:/i;

const RESERVED_WORD = new RegExp("^(?:" +
    "break|case|catch|class|const|continue|debugger|default|delete|do|" +
    "else|enum|export|extends|false|finally|for|function|if|import|in|" +
    "instanceof|new|null|return|super|switch|this|throw|true|try|typeof|" +
    "var|void|while|with|implements|private|public|interface|package|let|" +
    "protected|static|yield" +
")$");

function countNewlines(text) {

    let m = text.match(/\r\n?|\n/g);
    return m ? m.length : 0;
}

function preserveNewlines(text, height) {

    let n = countNewlines(text);

    if (height > 0 && n < height)
        text += "\n".repeat(height - n);

    return text;
}

function isAsyncType(type) {

    return type === "async" || type === "async-generator";
}

function isGeneratorType(type) {

    return type === "generator" || type === "async-generator";
}

class PatternTreeNode {

    constructor(name, init, skip) {

        this.name = name;
        this.initializer = init;
        this.children = [];
        this.target = "";
        this.skip = skip | 0;
        this.array = false;
        this.rest = false;
    }
}

class RootNode {

    constructor(root, end) {

        this.type = "Root";
        this.start = 0;
        this.end = end;
        this.root = root;
    }
}

RootNode.prototype = AST.Node.prototype;


function collapseScopes(parseResult) {

    let names = Object.create(null);

    visit(parseResult.scopeTree, null);

    function makeSuffix(name) {

        let count = names[name] | 0;
        names[name] = count + 1;
        return "$" + count;
    }

    function fail(msg, node) {

        throw parseResult.createSyntaxError("[esdown] " + msg, node);
    }

    function visit(scope, forScope) {

        switch (scope.type) {

            case "block":
                rename(scope);
                break;

            case "for":
                rename(scope);
                forScope = scope;
                break;

            case "function":

                if (forScope) {

                    let set = Object.create(null);

                    forScope.free.forEach(r => set[r.value] = 1);

                    scope.free.forEach(r => {

                        if (set[r.value] !== 1)
                            fail("Closure capturing per-iteration bindings", r);
                    });

                    forScope = null;
                }

                break;
        }

        scope.children.forEach(c => visit(c, forScope));
    }

    function rename(node) {

        /*

        TODO:  Throw a compile-time error if a lexical name is referenced in the same
        function (not a nested closure) before the binding is initialized.  This won't
        catch all potential TDZ issues but will help stop some obvious bugs.

        */

        let varParent = node.parent.type === "var";

        Object.keys(node.names).forEach(name => {

            let record = node.names[name],
                suffix = "";

            if (!varParent)
                suffix = makeSuffix(name);

            record.declarations.forEach(decl => decl.suffix = suffix);
            record.references.forEach(ref => ref.suffix = suffix);
        });
    }
}

export class Replacer {

    replace(input, options = {}) {

        this.asi = {};

        this.parseResult = parse(input, {

            module: options.module,
            addParentLinks: true,
            resolveScopes: true,

            onASI: token => {

                if (token.type !== "}" && token.type !== "EOF")
                    this.asi[token.start] = true;

                return true;
            }
        });

        let root = this.parseResult.ast;

        collapseScopes(this.parseResult);

        this.input = input;
        this.exports = {};
        this.imports = {};
        this.dependencies = [];
        this.isStrict = false;
        this.uid = 0;

        let visit = node => {

            node.text = null;

            // Call pre-order traversal method
            if (this[node.type + "Begin"])
                this[node.type + "Begin"](node);

            let strict = this.isStrict;

            // Set the strictness for implicitly strict nodes
            switch (node.type) {

                case "Module":
                case "ClassDeclaration":
                case "ClassExpresion":
                    this.isStrict = true;
            }

            // Perform a depth-first traversal
            node.children().forEach(visit);

            // Restore strictness
            this.isStrict = strict;

            let text = null;

            // Call replacer
            if (this[node.type])
                text = this[node.type](node);

            if (text === null || text === void 0)
                text = this.stringify(node);

            return node.text = this.syncNewlines(node.start, node.end, text);
        };

        let output = visit(new RootNode(root, input.length)),
            head = "";

        this.dependencies.forEach(dep => {

            if (head) head += ", ";
            else head = "var ";

            let url = dep.url,
                legacyFlag = dep.legacy ? ", 1" : "";

            head += `${ this.imports[url] } = __load(${ JSON.stringify(dep.url) }${ legacyFlag })`;
        });

        if (head)
            head += "; ";

        output = head + output;

        let exports = Object.keys(this.exports);

        if (exports.length > 0) {

            output += "\n";
            output += exports.map(k => `exports.${ k } = ${ this.exports[k] };`).join("\n");
            output += "\n";
        }

        return output;
    }

    DoWhileStatement(node) {

        let text = this.stringify(node);

        if (text.slice(-1) !== ";")
            return text + ";";
    }

    ForOfStatement(node) {

        let iter = this.addTempVar(node, null, true),
            iterResult = this.addTempVar(node, null, true),
            context = this.parentFunction(node),
            decl = "",
            binding,
            head;

        if (node.async) {

            head = `for (var ${ iter } = _esdown.asyncIter(${ node.right.text }), ${ iterResult }; `;
            head += `${ iterResult } = ${ this.awaitYield(context, iter + ".next()") }, `;

        } else {

            head = `for (var ${ iter } = _esdown.iter(${ node.right.text }), ${ iterResult }; `;
            head += `${ iterResult } = ${ iter }.next(), `;
        }

        head += `!${ iterResult }.done;`;
        head = this.syncNewlines(node.left.start, node.right.end, head);
        head += this.input.slice(node.right.end, node.body.start);

        if (node.left.type === "VariableDeclaration") {

            decl = "var ";
            binding = node.left.declarations[0].pattern;

        } else {

            binding = this.unwrapParens(node.left);
        }

        let body = node.body.text;

        // Remove braces from block bodies
        if (node.body.type === "Block") body = this.removeBraces(body);
        else body += " ";

        let assign = this.isPattern(binding) ?
            this.translatePattern(binding, `${ iterResult }.value`).join(", ") :
            `${ binding.text } = ${ iterResult }.value`;

        let out = `${ head }{ ${ decl }${ assign }; ${ body }}`;

        /*

        For-of loops are implicitly wrapped with try-finally, where the "return"
        is called upon the iterator (if it has such a method) when evaulation leaves
        the loop body.  For performance reasons, and because engines have not
        implemented "return" yet, we avoid this wrapper.

        out = `try { ${ out } } finally { ` +
            `if (${ iterResult } && !${ iterResult }.done && "return" in ${ iter }) ` +
                `${ iter }.return(); }`;

        */

        return out;
    }

    ExpressionStatement(node) {

        if (this.asi[node.start]) {

            let text = this.stringify(node);

            switch (text.charAt(0)) {

                case "(":
                case "[":
                    text = ";" + text;
                    break;
            }

            return text;
        }
    }

    Module(node) {

        // NOTE: Strict directive is included with module wrapper

        let inserted = [],
            temps = this.tempVars(node);

        if (node.lexicalVars)
            inserted.push(this.lexicalVarNames(node));

        if (temps)
            inserted.push(temps);

        if (inserted.length > 0)
            return inserted.join(" ") + " " + this.stringify(node);
    }

    Script(node) {

        return this.Module(node);
    }

    FunctionBody(node) {

        let insert = this.functionInsert(node.parent);

        if (insert)
            return "{ " + insert + " " + this.removeBraces(this.stringify(node)) + "}";
    }

    FormalParameter(node) {

        if (this.isPattern(node.pattern))
            return this.addTempVar(node, null, true);

        return node.pattern.text;
    }

    RestParameter(node) {

        node.parent.createRestBinding = true;

        let p = node.parent.params;

        if (p.length > 1) {

            let prev = p[p.length - 2];
            node.start = prev.end;
        }

        return "";
    }


    ComputedPropertyName(node) {

        search:
        for (let p = node.parent; p; p = p.parent) {

            switch (p.type) {

                case "ClassBody":
                case "ObjectLiteral":
                    p.hasComputed = true;
                    break search;
            }
        }

        return "_";
    }

    ObjectLiteral(node) {

        if (node.hasComputed) {

            let computed = false;

            node.properties.forEach((c, index) => {

                if (computed)
                    c.text = " }, { " + c.text;

                computed = c.name.type === "ComputedPropertyName";

                if (computed)
                    c.text = `}, ${ c.name.expression.text }, { ${ c.text }`;
            });

            return "_esdown.computed(" + this.stringify(node) + ")";
        }
    }

    ArrayLiteral(node) {

        if (node.hasSpread)
            return "(" + this.spreadList(node.elements, true) + ")";
    }

    MethodDefinition(node) {

        let text;

        switch (node.kind) {

            case "":
            case "constructor":

                text = "function(" +
                    this.joinList(node.params) + ") " +
                    node.body.text;

                break;

            case "async":
            case "async-generator":

                text = this.asyncFunction(node);
                break;

            case "generator":

                text = "function*(" +
                    this.joinList(node.params) + ") " +
                    node.body.text;

                break;

        }

        if (text !== void 0)
            return node.name.text + ": " + text;
    }

    PropertyDefinition(node) {

        if (node.expression === null) {

            let rawName = this.input.slice(node.name.start, node.name.end);
            return rawName + ": " + node.name.text;
        }
    }

    VariableDeclaration(node) {

        return this.stringify(node).replace(/^(let|const)/, "var");
    }

    ImportDeclaration(node) {

        let moduleSpec = this.modulePath(node.from),
            imports = node.imports,
            out = this.importVars(imports, moduleSpec);

        if (imports && imports.type === "DefaultImport" && imports.imports)
            out += " " + this.importVars(imports.imports, moduleSpec);

        return out;
    }

    importVars(imports, moduleSpec) {

        if (!imports)
            return "";

        switch (imports.type) {

            case "NamespaceImport":
                return "var " + imports.identifier.text + " = " + moduleSpec + ";";

            case "DefaultImport":
                return "var " + imports.identifier.text + " = " + moduleSpec + "['default'];";
        }

        let list = [];

        if (imports.specifiers) {

            imports.specifiers.forEach(spec => {

                let imported = spec.imported,
                    local = spec.local || imported;

                list.push({
                    start: spec.start,
                    end: spec.end,
                    text: local.text + " = " + moduleSpec + "." + imported.text
                });
            });
        }

        if (list.length === 0)
            return "";

        return "var " + this.joinList(list) + ";";
    }

    ExportDeclaration(node) {

        let target = node.declaration,
            exports = this.exports,
            ident;

        if (target.type === "VariableDeclaration") {

            target.declarations.forEach(decl => {

                if (this.isPattern(decl.pattern)) {

                    decl.pattern.patternTargets.forEach(x => exports[x] = x);

                } else {

                    ident = decl.pattern.text;
                    exports[ident] = ident;
                }
            });

        } else {

            ident = target.identifier.text;
            exports[ident] = ident;
        }

        return target.text;
    }

    ExportNameList(node) {

        let from = node.from,
            fromPath = from ? this.modulePath(from) : "";

        node.specifiers.forEach(spec => {

            let local = spec.local.text,
                exported = spec.exported ? spec.exported.text : local;

            this.exports[exported] = from ?
                fromPath + "." + local :
                local;
        });

        return "";
    }

    ExportDefaultFrom(node) {

        let from = node.from,
            fromPath = from ? this.modulePath(from) : "";

        this.exports[node.identifier.text] = fromPath + "['default']";

        return "";
    }

    ExportNamespace(node) {

        let from = node.from,
            fromPath = from ? this.modulePath(from) : "";

        if (from && node.identifier) {

            this.exports[node.identifier.text] = fromPath;
            return "";
        }

        return "Object.keys(" + fromPath + ").forEach(function(k) { exports[k] = " + fromPath + "[k]; });";
    }

    ExportDefault(node) {

        switch (node.binding.type) {

            case "ClassDeclaration":
            case "FunctionDeclaration":
                this.exports["default"] = node.binding.identifier.text;
                return node.binding.text;
        }

        return `exports["default"] = ${ node.binding.text };`;
    }

    CallExpression(node) {

        let callee = node.callee,
            args = node.arguments,
            spread = null,
            calleeText,
            argText;

        if (callee.type === "SuperKeyword")
            throw new Error("Super call not supported");

        if (node.hasSpread)
            spread = this.spreadList(args, false);

        if (node.injectThisArg) {

            argText = node.injectThisArg;

            if (spread)
                argText = argText + ", " + spread;
            else if (args.length > 0)
                argText = argText + ", " + this.joinList(args);

            return callee.text + "." + (spread ? "apply" : "call") + "(" + argText + ")";
        }

        if (spread) {

            argText = "void 0";

            if (node.callee.type === "MemberExpression") {

                argText = this.addTempVar(node);

                callee.object.text = `(${ argText } = ${ callee.object.text })`;
                callee.text = this.MemberExpression(callee) || this.stringify(callee);
            }

            return callee.text + ".apply(" + argText + ", " + spread + ")";
        }
    }

    SpreadExpression(node) {

        node.parent.hasSpread = true;
    }

    SuperKeyword(node) {

        let proto = "__.super",
            p = node.parent,
            elem = p;

        while (elem && elem.type !== "MethodDefinition")
            elem = elem.parent;

        if (elem && elem.static)
            proto = "__.csuper";

        if (p.type !== "CallExpression") {

            // super.foo...
            p.isSuperLookup = true;

            let pp = this.parenParent(p);

            // super.foo(args);
            if (pp[0].type === "CallExpression" && pp[0].callee === pp[1])
                pp[0].injectThisArg = "this";
        }

        return proto;
    }

    MemberExpression(node) {

        if (node.isSuperLookup) {

            let prop = node.property.text;

            prop = node.computed ?
                "[" + prop + "]" :
                "." + prop;

            return node.object.text + prop;
        }

        // TODO:  What about super.@x?
        if (node.property.type === "AtName")
            return this.privateReference(node, node.object.text, node.property.text);
    }

    BindExpression(node) {

        let left = node.left ? node.left.text : null,
            temp = this.addTempVar(node),
            bindee;

        if (!left) {

            let right = this.unwrapParens(node.right);
            bindee = `((${ temp } = ${ right.object.text }).${ right.property.text })`;

        } else {

            bindee = `(${ temp } = ${ left }, ${ node.right.text })`;
        }

        if (node.parent.type === "CallExpression" &&
            node.parent.callee === node) {

            node.parent.injectThisArg = temp;
            return bindee;
        }

        return `${ bindee }.bind(${ temp })`;
    }

    ArrowFunction(node) {

        let body = node.body.text;

        if (node.body.type !== "FunctionBody") {

            let insert = this.functionInsert(node);

            if (insert)
                insert += " ";

            body = "{ " + insert + "return " + body + "; }";
        }

        let text = node.kind === "async" ?
            this.asyncFunction(node, body) :
            "function(" + this.joinList(node.params) + ") " + body;

        return this.wrapFunctionExpression(text, node);
    }

    ThisExpression(node) {

        return this.renameLexicalVar(node, "this");
    }

    Identifier(node) {

        if (node.value === "arguments" && node.context === "variable")
            return this.renameLexicalVar(node, "arguments");

        if (node.suffix)
            return this.input.slice(node.start, node.end) + node.suffix;
    }

    UnaryExpression(node) {

        if (node.operator === "delete" && node.overrideDelete)
            return "!void " + node.expression.text;

        if (node.operator === "await")
            return this.awaitYield(this.parentFunction(node), node.expression.text);
    }

    YieldExpression(node) {

        // V8 circa Node 0.11.x does not support yield without expression
        if (!node.expression)
            return "yield void 0";

        // V8 circa Node 0.11.x does not access Symbol.iterator correctly
        if (node.delegate) {

            let fn = this.parentFunction(node),
                method = isAsyncType(fn.kind) ? "asyncIter" : "iter";

            node.expression.text = `_esdown.${ method }(${ node.expression.text })`;
        }
    }

    FunctionDeclaration(node) {

        if (isAsyncType(node.kind))
            return this.asyncFunction(node);
    }

    FunctionExpression(node) {

        return this.FunctionDeclaration(node);
    }

    ClassDeclaration(node) {

        if (node.base)
            this.fail("Subclassing not supported", node.base);

        return "var " + node.identifier.text + " = _esdown.class(" +
            (node.base ? (node.base.text + ", ") : "") +
            "function(__) {" +
                this.strictDirective() +
                this.removeBraces(node.body.text) + " });";
    }

    ClassExpression(node) {

        let before = "",
            after = "";

        if (node.base)
            this.fail("Subclassing not supported", node.base);

        if (node.identifier) {

            before = "function() { var " + node.identifier.text + " = ";
            after = "; return " + node.identifier.text + "; }()";
        }

        return "(" + before +
            "_esdown.class(" +
            (node.base ? (node.base.text + ", ") : "") +
            "function(__) {" +
                this.strictDirective() +
                this.removeBraces(node.body.text) + " })" +
            after + ")";
    }

    PrivateDeclaration(node) {

        let init = node.initializer;

        if (node.static)
            return "__private_ctor." + node.name.text + " = " + (init ? init.text : "void 0") + ";";

        if (init) {

            node.parent.privateNames[node.name.text].init = true;
            return "function __init_" + node.name.text + "() { return " + init.text + "; }";
        }

        return "";
    }

    AtName(node) {

        let name = node.value.slice(1),
            parent = node.parent;

        switch (parent.type) {

            case "MemberExpression":
                if (parent.property === node)
                    return name;

                break;

            case "PrivateDeclaration":
            case "MethodDefinition":
            case "PropertyDefinition":
                return name;
        }
    }

    ClassBodyBegin(node) {

        let ctor = null;

        node.elements.forEach(e => {

            switch (e.type) {

                case "MethodDefinition":

                    if (e.name.type === "AtName")
                        this.addPrivateName(node, e.name.value.slice(1), true, e.static);

                    if (e.kind === "constructor")
                        ctor = e;

                    break;

                case "PrivateDeclaration":

                    if (e.name.type === "AtName")
                        this.addPrivateName(node, e.name.value.slice(1), false, e.static);

                    break;
            }
        });

        if (ctor && node.privateNames)
            ctor.initPrivate = true;
    }

    ClassBody(node) {

        let classIdent = node.parent.identifier,
            hasBase = !!node.parent.base,
            elems = node.elements,
            hasCtor = false,
            ctorName = classIdent ? classIdent.value : "__ctor",
            header = [],
            footer = [];

        elems.reduce((prev, e, index) => {

            if (e.type !== "MethodDefinition")
                return "";

            let text = e.text,
                fn = "__",
                target = "";

            if (e.name.type === "AtName")
                target = e.static ? "__private_ctor" : "__private_proto";
            else if (e.static)
                fn += ".static";

            if (e.static)
                text = text.replace(/^static\s*/, "");

            if (e.kind === "constructor") {

                hasCtor = true;

                // Give the constructor function a name so that the class function's
                // name property will be correct and capture the constructor.
                text = text.replace(/:\s*function/, ": " + ctorName + " = function");
            }

            let prefix = fn + "(" + (target ? target + ", " : "");

            if (e.name.type === "ComputedPropertyName") {

                e.text = prefix + "_esdown.computed({}, " + e.name.expression.text + ", { " + text + " }));";
                prefix = "";

            } else if (prefix === prev) {

                let p = elems[index - 1];
                p.text = p.text.replace(/\}\);$/, ",");
                e.text = text + "});"

            } else {

                e.text = prefix + "{ " + text + "});";
            }

            return prefix;

        }, "");

        header.push("var " + ctorName + ";");

        if (node.privateNames) {

            header.push(this.privateInit(node));
            footer.push("__private_static" + node.privateID + ".set(" + ctorName + ", __private_ctor);");
        }

        // Add a default constructor if none was provided
        if (!hasCtor) {

            let ctorBody = "";

            if (hasBase)
                ctorBody = "__.csuper.apply(this, arguments);";

            if (node.privateNames) {

                if (ctorBody) ctorBody = " " + ctorBody;
                ctorBody += "__initPrivate(this);";
            }

            if (ctorBody)
                ctorBody = " " + ctorBody + " ";

            let ctor = ctorName + " = function() {" + ctorBody + "}";

            header.push("__({ constructor: " + ctor + " });");
        }

        let text = this.stringify(node);

        if (header.length > 0)
            text = "{ " + header.join(" ") + text.slice(1);

        if (footer.length > 0)
            text = text.slice(1, -1) + " " + footer.join(" ") + " }";

        return text;
    }

    TaggedTemplateExpression(node) {

        return "(" + this.stringify(node) + ")";
    }

    TemplateExpression(node) {

        let lit = node.literals,
            sub = node.substitutions,
            out = "";

        if (node.parent.type === "TaggedTemplateExpression") {

            out = "(_esdown.callSite(" +
                "[" + lit.map(x => this.rawToString(x.raw)).join(", ") + "]";

            // Only output the raw array if it is different from the cooked array
            for (let i = 0; i < lit.length; ++i) {

                if (lit[i].raw !== lit[i].value) {

                    out += ", [" + lit.map(x => JSON.stringify(x.raw)).join(", ") + "]";
                    break;
                }
            }

            out += ")";

            if (sub.length > 0)
                out += ", " + sub.map(x => x.text).join(", ");

            out += ")";

        } else {

            for (let i = 0; i < lit.length; ++i) {

                if (i > 0)
                    out += " + (" + sub[i - 1].text + ") + ";

                out += this.rawToString(lit[i].raw);
            }
        }

        return out;
    }

    CatchClause(node) {

        if (!this.isPattern(node.param))
            return null;

        let temp = this.addTempVar(node, null, true),
            assign = this.translatePattern(node.param, temp).join(", "),
            body = this.removeBraces(node.body.text);

        return `catch (${ temp }) { let ${ assign }; ${ body } }`;
    }

    VariableDeclarator(node) {

        if (!node.initializer || !this.isPattern(node.pattern))
            return null;

        let list = this.translatePattern(node.pattern, node.initializer.text);

        return list.join(", ");
    }

    AssignmentExpression(node) {

        if (node.assignWrap)
            return node.assignWrap[0] + node.right.text + node.assignWrap[1];

        let left = this.unwrapParens(node.left);

        if (!this.isPattern(left))
            return null;

        let temp = this.addTempVar(node),
            list = this.translatePattern(left, temp);

        list.unshift(temp + " = " + node.right.text);
        list.push(temp);

        return "(" + list.join(", ") + ")";
    }

    isPattern(node) {

        switch (node.type) {

            case "ArrayPattern":
            case "ObjectPattern":
                return true;
        }

        return false;
    }

    parenParent(node) {

        let parent;

        for (; parent = node.parent; node = parent)
            if (parent.type !== "ParenExpression")
                break;

        return [parent, node];
    }

    unwrapParens(node) {

        while (node && node.type === "ParenExpression")
            node = node.expression;

        return node;
    }

    spreadList(elems, newArray) {

        let list = [],
            last = -1;

        for (let i = 0; i < elems.length; ++i) {

            if (elems[i].type === "SpreadExpression") {

                if (last < i - 1)
                    list.push({ type: "s", args: this.joinList(elems.slice(last + 1, i)) });

                list.push({ type: "i", args: elems[i].expression.text });

                last = i;
            }
        }

        if (last < elems.length - 1)
            list.push({ type: "s", args: this.joinList(elems.slice(last + 1)) });

        let out = "(_esdown.spread()";

        for (let i = 0; i < list.length; ++i)
            out += `.${ list[i].type }(${ list[i].args })`;

        out += ".a)";

        return out;
    }

    translatePattern(node, base) {

        function propGet(name) {

            return /^[\.\d'"]/.test(name) ?
                "[" + name + "]" :
                "." + name;
        }

        let outer = [],
            inner = [],
            targets = [];

        node.patternTargets = targets;

        let visit = (tree, base) => {

            let target = tree.target,
                dType = tree.array ? "arrayd" : "objd",
                str = "",
                temp;

            let access =
                tree.rest ? `${ base }.rest(${ tree.skip }, ${ tree.name })` :
                tree.skip ? `${ base }.at(${ tree.skip }, ${ tree.name })` :
                tree.name ? base + propGet(tree.name) :
                base;

            if (tree.initializer) {

                temp = this.addTempVar(node);
                inner.push(`${ temp } = ${ access }`);

                str = `${ temp } === void 0 ? ${ tree.initializer } : ${ temp }`;

                if (!tree.target)
                    str = `${ temp } = _esdown.${ dType }(${ str })`;

                inner.push(str);

            } else if (tree.target) {

                inner.push(`${ access }`);

            } else {

                temp = this.addTempVar(node);
                inner.push(`${ temp } = _esdown.${ dType }(${ access })`);
            }

            if (tree.target) {

                targets.push(target);

                outer.push(inner.length === 1 ?
                    `${ target } = ${ inner[0] }` :
                    `${ target } = (${ inner.join(", ") })`);

                inner.length = 0;
            }

            if (temp)
                base = temp;

            tree.children.forEach(c => visit(c, base));
        };

        visit(this.createPatternTree(node), base);

        return outer;
    }

    createPatternTree(ast, parent) {

        if (!parent)
            parent = new PatternTreeNode("", null);

        let child, init, skip = 1;

        switch (ast.type) {

            case "ArrayPattern":

                parent.array = true;

                ast.elements.forEach((e, i) => {

                    if (!e) {

                        ++skip;
                        return;
                    }

                    init = e.initializer ? e.initializer.text : "";

                    child = new PatternTreeNode(String(i), init, skip);

                    if (e.type === "PatternRestElement")
                        child.rest = true;

                    parent.children.push(child);
                    this.createPatternTree(e.pattern, child);

                    skip = 1;
                });

                break;

            case "ObjectPattern":

                ast.properties.forEach(p => {

                    init = p.initializer ? p.initializer.text : "";
                    child = new PatternTreeNode(p.name.text, init);

                    parent.children.push(child);
                    this.createPatternTree(p.pattern || p.name, child);
                });

                break;

            default:

                parent.target = ast.text;
                break;
        }

        return parent;
    }

    asyncFunction(node, body) {

        let head = "function";

        if (node.identifier)
            head += " " + node.identifier.text;

        let outerParams = node.params.map((x, i) => {

            let p = x.pattern || x.identifier;
            return p.type === "Identifier" ? p.value : "__$" + i;

        }).join(", ");

        let wrapper = node.kind === "async-generator" ? "asyncGen" : "async";

        if (body === void 0)
            body = node.body.text;

        return `${ head }(${ outerParams }) { ` +
            `return _esdown.${ wrapper }(function*(${ this.joinList(node.params) }) ` +
            `${ body }.apply(this, arguments)); }`;
    }

    findPrivateName(node, name) {

        for (let n = node; n; n = n.parent) {

            let names = n.privateNames;

            if (names && names[name])
                return names[name];
        }

        this.fail("Unable to find private name @" + name, node);
    }

    addPrivateName(scope, ident, isMethod, isStatic) {

        let privateID = scope.privateID;

        if (privateID === void 0) {

            privateID = scope.privateID = this.uid++;
            scope.privateNames = Object.create(null);
        }

        scope.privateNames[ident] = {
            ident,
            init: null,
            method: isMethod,
            static: isStatic,
            map: "__private" + (isStatic ? "_static" : "") + privateID
        };
    }

    privateReference(node, obj, prop) {

        let pp = this.parenParent(node),
            p = pp[0],
            mapName = this.findPrivateName(p, prop).map,
            type = "get";

        switch (p.type) {

            case "CallExpression":
                if (p.callee === pp[1]) type = "call";
                break;

            case "AssignmentExpression":
                if (p.left === pp[1]) type = "set";
                break;

            case "PatternProperty":
            case "PatternElement":
                // References within assignment patterns are not currently supported
                return null;

            case "UnaryExpression":
                if (p.operator === "delete")
                    this.fail("Cannot delete private reference", p.expression);

                break;
        }

        let temp;

        switch (type) {

            case "call":
                temp = this.addTempVar(p);
                p.injectThisArg = temp;
                return `_esdown.getPrivate(${ temp } = ${ obj }, ${ mapName }, "${ prop }")`;

            case "get":
                return `_esdown.getPrivate(${ obj }, ${ mapName }, "${ prop }")`;

            case "set":
                temp = this.addTempVar(p);

                p.assignWrap = [
                    `(_esdown.setPrivate(${ obj }, ${ mapName }, "${ prop }", ${ temp } = `,
                    `), ${ temp })`
                ];

                return null;
        }
    }

    privateInit(scope) {

        let id = scope.privateID;

        let instance = Object
            .keys(scope.privateNames)
            .filter(name => {
                let entry = scope.privateNames[name];
                return !entry.method && !entry.static;
            });

        return "var __private" + id + " = new WeakMap, " +
            "__private_static" + id + " = new WeakMap, " +
            "__private_ctor = {}, " +
            "__private_proto = {}; " +
        "function __initPrivate(__$) { " +
            "if (__private" + id + ".has(__$)) " +
                "throw new TypeError('Object already initialized'); " +
            "var __p; " +
            "__private" + id + ".set(__$, __p = Object.create(__private_proto, { " +
                instance.map(name => name + ": { writable: true }").join(", ") +
            " })); " +
            instance
                .filter(name => scope.privateNames[name].init)
                .map(name => "__p." + name + " = __init_" + name + "(); ").join("") +
        "}";
    }

    rawToString(raw) {

        raw = raw.replace(/([^\n])?\n/g, (m, m1) => m1 === "\\" ? m : (m1 || "") + "\\n\\\n");
        raw = raw.replace(/([^"])?"/g, (m, m1) => m1 === "\\" ? m : (m1 || "") + '\\"');

        return '"' + raw + '"';
    }

    isVarScope(node) {

        switch (node.type) {

            case "ArrowFunction":
            case "FunctionDeclaration":
            case "FunctionExpression":
            case "MethodDefinition":
            case "Script":
            case "Module":
                return true;
        }

        return false;
    }

    parentFunction(node) {

        for (let p = node.parent; p; p = p.parent)
            if (this.isVarScope(p))
                return p;

        return null;
    }

    renameLexicalVar(node, name) {

        let fn = this.parentFunction(node),
            varName = name;

        if (fn.type === "ArrowFunction") {

            while (fn = this.parentFunction(fn)) {

                if (fn.type !== "ArrowFunction") {

                    if (!fn.lexicalVars)
                        fn.lexicalVars = {};

                    fn.lexicalVars[name] = varName = "__" + name;
                    break;
                }
            }
        }

        return varName;
    }

    lexicalVarNames(node) {

        let names = node.lexicalVars;

        if (!names)
            return "";

        return "var " + Object.keys(names).map(key => {

            return names[key] + " = " + key;

        }).join(", ") + ";";
    }

    modulePath(node) {

        return node.type === "StringLiteral" ?
            this.identifyModule(node.value) :
            this.stringify(node);
    }

    identifyModule(url) {

        let legacy = false;

        url = url.trim();

        if (isLegacyScheme(url)) {

            url = removeScheme(url).trim();
            legacy = true;
        }

        if (typeof this.imports[url] !== "string") {

            this.imports[url] = "_M" + (this.uid++);
            this.dependencies.push({ url, legacy });
        }

        return this.imports[url];
    }

    stringify(node) {

        let offset = node.start,
            input = this.input,
            text = "";

        // Build text from child nodes
        node.children().forEach(child => {

            if (offset < child.start)
                text += input.slice(offset, child.start);

            text += child.text;
            offset = child.end;
        });

        if (offset < node.end)
            text += input.slice(offset, node.end);

        return text;
    }

    restParamVar(node) {

        let name = node.params[node.params.length - 1].identifier.value,
            pos = node.params.length - 1,
            temp = this.addTempVar(node, null, true);

        return `for (var ${ name } = [], ${ temp } = ${ pos }; ` +
            `${ temp } < arguments.length; ` +
            `++${ temp }) ${ name }.push(arguments[${ temp }]);`;

        return "var " + name + " = " + slice + ";";
    }

    functionInsert(node) {

        let inserted = [];

        if (node.hasYieldInput)
            inserted.push("var __yieldin = yield;");

        if (node.lexicalVars)
            inserted.push(this.lexicalVarNames(node));

        if (node.initPrivate)
            inserted.push("__initPrivate(this);");

        if (node.createRestBinding)
            inserted.push(this.restParamVar(node));

        node.params.forEach(param => {

            if (!param.pattern)
                return;

            let name = param.text;

            if (param.initializer)
                inserted.push(`if (${ name } === void 0) ${ name } = ${ param.initializer.text };`);

            if (this.isPattern(param.pattern))
                inserted.push("var " +  this.translatePattern(param.pattern, name).join(", ") + ";");
        });

        let temps = this.tempVars(node);

        // Add temp var declarations to the top of the insert
        if (temps)
            inserted.unshift(temps);

        return inserted.join(" ");
    }

    addTempVar(node, value, noDeclare) {

        let p = this.isVarScope(node) ? node : this.parentFunction(node);

        if (!p.tempVars)
            p.tempVars = [];

        let name = "__$" + p.tempVars.length;

        p.tempVars.push({ name, value, noDeclare });

        return name;
    }

    tempVars(node) {

        if (!node.tempVars)
            return "";

        let list = node.tempVars.filter(item => !item.noDeclare);

        if (list.length === 0)
            return "";

        return "var " + list.map(item => {

            let out = item.name;

            if (typeof item.value === "string")
                out += " = " + item.value;

            return out;

        }).join(", ") + ";";
    }

    strictDirective() {

        return this.isStrict ? "" : ' "use strict";';
    }

    lineNumber(offset) {

        return this.parseResult.locate(offset).line;
    }

    syncNewlines(start, end, text) {

        let height = this.lineNumber(end - 1) - this.lineNumber(start);
        return preserveNewlines(text, height);
    }

    awaitYield(context, text) {

        if (context.kind === "async-generator")
            text = `{ _esdown_await: (${ text }) }`;

        return `(yield ${ text })`;
    }

    wrapFunctionExpression(text, node) {

        for (let p = node.parent; p; p = p.parent) {

            if (this.isVarScope(p))
                break;

            if (p.type === "ExpressionStatement") {

                if (p.start === node.start)
                    return "(" + text + ")";

                break;
            }
        }

        return text;
    }

    removeBraces(text) {

        return text.replace(/^\s*\{|\}\s*$/g, "");
    }

    joinList(list) {

        let input = this.input,
            offset = -1,
            text = "";

        list.forEach(child => {

            if (offset >= 0 && offset < child.start)
                text += input.slice(offset, child.start);

            text += child.text;
            offset = child.end;
        });

        return text;
    }

    fail(msg, node) {

        throw this.parseResult.createSyntaxError("[esdown] " + msg, node);
    }

}
