var FS = require("fs"),
    Path = require("path");

var apiPath = Path.resolve(__dirname, "../runtime/API.js"),
    manifestPath = Path.resolve(__dirname, "../package.json");

var replacers = [

    {
        path: "../runtime/API.js",

        findVersion: function(text) {

            var m = /((?:^|\n)const VERSION = )"(\d+(?:\.\d+)*)"/.exec(text);

            if (m && m[2])
                return m[2];

            return "";
        },

        replace: function(text, version) {

            return text.replace(
                /((?:^|\n)const VERSION = )"(\d+(?:\.\d+)*)"/,
                '$1"' + version + '"');
        }
    },

    {
        path: "../package.json",

        replace: function(text, version) {

            return text.replace(
                /(\n\s*"version"\s*:\s*)"(\d+(?:\.\d+)*)"/,
                '$1"' + version + '"');
        }
    }

];

var newVersion = "";

if (process.argv.length > 2)
    newVersion = process.argv[2];

replacers.forEach(function(replacer) {

    var path = Path.resolve(__dirname, replacer.path),
        text = FS.readFileSync(path, { encoding: "utf8" });

    if (!newVersion) {

        newVersion = replacer.findVersion(text);

        if (!newVersion)
            throw new Error("Version string not found in " + replacer.path);

        var parts = newVersion.split(/\./),
            last = Number(parts.pop()) + 1;

        if (isNaN(last))
            throw new Error("Unable to bump version string " + newVersion);

        parts.push(last + "");

        newVersion = parts.join(".");
    }

    var replaced = replacer.replace(text, newVersion);

    console.log("Updating '" + replacer.path + "' to version '" + newVersion + "'");
    FS.writeFileSync(path, replaced);
});

console.log("Rebuilding runtime module")
require("./runtime.js");
