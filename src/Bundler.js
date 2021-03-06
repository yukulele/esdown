import * as Path from "node:path";
import { readFile } from "./AsyncFS.js";
import { isPackageSpecifier, locateModule } from "./Locator.js";
import { translate, wrapModule } from "./Translator.js";
import { Replacer } from "./Replacer.js";
import { isLegacyScheme, removeScheme, hasScheme } from "./Schema.js";


class Node {

    constructor(path, name) {

        this.path = path;
        this.name = name;
        this.edges = new Set;
        this.output = null;
    }
}

class GraphBuilder {

    constructor(root) {

        this.nodes = new Map;
        this.nextID = 1;
        this.root = this.add(root);
    }

    has(key) {

        return this.nodes.has(key);
    }

    add(key) {

        if (this.nodes.has(key))
            return this.nodes.get(key);

        let name = "_M" + (this.nextID++),
            node = new Node(key, name);

        this.nodes.set(key, node);
        return node;
    }

    sort(key = this.root.path) {

        let visited = new Set,
            list = [];

        let visit = key => {

            if (visited.has(key))
                return;

            visited.add(key);
            let node = this.nodes.get(key);
            node.edges.forEach(visit);
            list.push(node);
        };

        visit(key);

        return list;
    }

    process(key, input) {

        if (!this.nodes.has(key))
            throw new Error("Node not found");

        let node = this.nodes.get(key);

        if (node.output !== null)
            throw new Error("Node already processed");

        let replacer = new Replacer,
            dir = Path.dirname(node.path);

        replacer.identifyModule = path => {

            // REVISIT:  Does not currently allow bundling of legacy modules
            path = locateModule(path, dir).path;
            node.edges.add(path);
            return this.add(path).name;
        };

        node.output = translate(input, { replacer, module: true });

        return node;
    }

}

export function bundle(rootPath, options = {}) {

    rootPath = Path.resolve(rootPath);

    let builder = new GraphBuilder(rootPath),
        visited = new Set,
        pending = 0,
        resolver,
        allFetched;

    allFetched = new Promise((resolve, reject) => resolver = { resolve, reject });

    function visit(path) {

        // Exit if module has already been processed
        if (visited.has(path))
            return;

        visited.add(path);
        pending += 1;

        readFile(path, { encoding: "utf8" }).then(code => {

            let node = builder.process(path, code);

            node.edges.forEach(path => {

                // If we want to optionally limit the scope of the bundle, we
                // will need to apply some kind of filter here.

                // Do not bundle any files that start with a scheme prefix
                if (!hasScheme(path))
                    visit(path);
            });

            pending -= 1;

            if (pending === 0)
                resolver.resolve(null);

        }).then(null, err => {

            if (err instanceof SyntaxError && "sourceText" in err)
                err.filename = path;

            resolver.reject(err);
        });
    }

    visit(rootPath);

    return allFetched.then($=> {

        let nodes = builder.sort(),
            dependencies = [],
            output = "";

        let varList = nodes.map(node => {

            if (node.output === null) {

                let path = node.path,
                    legacy = "";

                if (isLegacyScheme(path)) {

                    path = removeScheme(node.path);
                    legacy = ", 1";
                }

                dependencies.push(path);

                return `${ node.name } = __load(${ JSON.stringify(path) }${ legacy })`;
            }

            return `${ node.name } = ${ node.path === rootPath ? "exports" : "{}" }`;

        }).join(", ");

        if (varList)
            output += "var " + varList + ";\n";

        nodes.filter(n => n.output !== null).forEach(node => {

            output +=
                "\n(function(exports) {\n\n" +
                node.output +
                "\n\n}).call(this, " + node.name + ");\n";
        });

        if (options.runtime)
            output = translate("", { runtime: true, module: true }) + "\n\n" + output;

        return wrapModule(output, dependencies, options.global);
    });
}
