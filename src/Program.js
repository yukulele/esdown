module FS from "node:fs";
module Path from "node:path";
module AsyncFS from "AsyncFS.js";

import { bundle } from "Bundler.js";
import { translate } from "Translator.js";
import { Server } from "Server.js";
import { ConsoleCommand, Style } from "ConsoleCommand.js";

var ES6_GUESS = /(?:^|\n)\s*(?:import|export|class)\s/;

function absPath(path) {

    return Path.resolve(process.cwd(), path);
}

function getOutPath(inPath, outPath) {

    var stat;
    
    outPath = absPath(outPath);
    
    try { stat = FS.statSync(outPath); } catch (e) {}
    
    if (stat && stat.isDirectory())
        return Path.resolve(outPath, Path.basename(inPath));
    
    return outPath;
}

function overrideCompilation() {

    // Compile ES6 js files
    require.extensions[".js"] = (module, filename) => {
    
        var text, source;
        
        try {
        
            text = source = FS.readFileSync(filename, "utf8");
            
            if (ES6_GUESS.test(text))
                text = translate(text);
        
        } catch (e) {
        
            if (e instanceof SyntaxError) {
            
                var desc = e.message + "\n" +
                    "    at " + filename + ":" + e.line + "\n\n" + 
                    source.slice(e.lineOffset, e.startOffset) +
                    Style.bold(Style.red(source.slice(e.startOffset, e.endOffset))) + 
                    source.slice(e.endOffset, source.indexOf("\n", e.endOffset)) +
                    "\n";
                
                e = new SyntaxError(desc);
            }
            
            throw e;
        }
        
        return module._compile(text, filename);
    };
}

export function run() {

    new ConsoleCommand({

        params: {
        
            "target": {
            
                positional: true,
                required: true
            }
        },
        
        execute(params) {
        
            params.debug = true;
            overrideCompilation();
            process.argv.splice(1, 1);
            require(absPath(params.target));
        }
        
    }).add("translate", {
    
        params: {
                
            "input": {
    
                short: "i",
                positional: true,
                required: true
            },
            
            "output": {
                
                short: "o",
                positional: true,
                required: false
            },
            
            "global": { short: "g" },
            
            "bundle": { short: "b", flag: true }
        },
        
        execute(params) {
            
            var promise = params.bundle ?
                bundle(params.input) :
                AsyncFS.readFile(params.input, { encoding: "utf8" });
            
            promise.then(text => {
            
                return translate(text, { global: params.global });
            
            }).then(text => {
                
                if (params.output) {
                
                    var outPath = getOutPath(params.input, params.output);
                    FS.writeFileSync(outPath, text, "utf8");
                
                } else {
                
                    console.log(text);
                }
                
            });
        }
    
    }).add("serve", {
    
        params: {
        
            "root": { short: "r", positional: true },
            "port": { short: "p", positional: true }
        },
        
        execute(params) {
        
            var server = new Server(params);
            server.start();
            
            console.log("Listening on port " + server.port + ".  Press Enter to exit.");
            
            var stdin = process.stdin;
            
            stdin.resume();
            stdin.setEncoding('utf8');
            
            stdin.on("data", () => { 
            
                server.stop().then(val => { process.exit(0); });
            });
        }
        
    }).run();
    
}