// === Polyfill Utilities ===

function eachKey(obj, fn) {

    let keys = Object.getOwnPropertyNames(obj);

    for (let i = 0; i < keys.length; ++i)
        fn(keys[i]);

    if (!Object.getOwnPropertySymbols)
        return;

    keys = Object.getOwnPropertySymbols(obj);

    for (let i = 0; i < keys.length; ++i)
        fn(keys[i]);
}

function polyfill(obj, methods) {

    eachKey(methods, key => {

        if (key in obj)
            return;

        Object.defineProperty(obj, key, {

            value: methods[key],
            configurable: true,
            enumerable: false,
            writable: true
        });

    });
}


// === Spec Helpers ===

var sign = Math.sign || function(val) {

    let n = +val;

    if (n === 0 || Number.isNaN(n))
        return n;

    return n < 0 ? -1 : 1;
};

function toInteger(val) {

    let n = +val;

    return n !== n /* n is NaN */ ? 0 :
        (n === 0 || !isFinite(n)) ? n :
        sign(n) * Math.floor(Math.abs(n));
}

function toLength(val) {

    let n = toInteger(val);
    return n < 0 ? 0 : Math.min(n, Number.MAX_SAFE_INTEGER);
}

function sameValue(left, right) {

    if (left === right)
        return left !== 0 || 1 / left === 1 / right;

    return left !== left && right !== right;
}

function isRegExp(val) {

    return Object.prototype.toString.call(val) == "[object RegExp]";
}

function toObject(val) {

    if (val == null)
        throw new TypeError(val + " is not an object");

    return Object(val);
}

function iteratorMethod(obj) {

    // TODO:  What about typeof === "string"?
    if (!obj || typeof obj !== "object")
        return null;

    let m = obj[Symbol.iterator];

    // Generator iterators in Node 0.11.13 do not have a [Symbol.iterator] method
    if (!m && typeof obj.next === "function" && typeof obj.throw === "function")
        return function() { return this };

    return m;
}

function assertThis(val, name) {

    if (val == null)
        throw new TypeError(name + " called on null or undefined");
}

// === Symbols ===

let symbolCounter = 0,
    global = _esdown.global;

function fakeSymbol() {

    return "__$" + Math.floor(Math.random() * 1e9) + "$" + (++symbolCounter) + "$__";
}

if (!global.Symbol)
    global.Symbol = fakeSymbol;

polyfill(Symbol, {

    iterator: Symbol("iterator"),

    species: Symbol("species"),

    // Experimental async iterator support
    asyncIterator: Symbol("asyncIterator"),

});

// === Object ===

polyfill(Object, {

    is: sameValue,

    assign(target, source) {

        target = toObject(target);

        for (let i = 1; i < arguments.length; ++i) {

            source = arguments[i];

            if (source != null) // null or undefined
                Object.keys(source).forEach(key => target[key] = source[key]);
        }

        return target;
    },

    setPrototypeOf(object, proto) {

        // Least effort attempt
        object.__proto__ = proto;
    },

    getOwnPropertySymbols() {

        // If getOwnPropertySymbols is not supported, then just return an
        // empty array so that we can avoid feature testing
    }

});

// === Number ===

function isInteger(val) {

    return typeof val === "number" && isFinite(val) && toInteger(val) === val;
}

function epsilon() {

    // Calculate the difference between 1 and the smallest value greater than 1 that
    // is representable as a Number value

    let result;

    for (let next = 1; 1 + next !== 1; next = next / 2)
        result = next;

    return result;
}

polyfill(Number, {

    EPSILON: epsilon(),
    MAX_SAFE_INTEGER: 9007199254740991,
    MIN_SAFE_INTEGER: -9007199254740991,

    parseInt: parseInt,
    parseFloat: parseFloat,
    isInteger: isInteger,
    isFinite(val) { return typeof val === "number" && isFinite(val) },
    isNaN(val) { return val !== val },
    isSafeInteger(val) { return isInteger(val) && Math.abs(val) <= Number.MAX_SAFE_INTEGER }

});

// === String ===

polyfill(String, {

    raw(callsite, ...args) {

        let raw = callsite.raw,
            len = toLength(raw.length);

        if (len === 0)
            return "";

        let s = "", i = 0;

        while (true) {

            s += raw[i];
            if (i + 1 === len || i >= args.length) break;
            s += args[i++];
        }

        return s;
    },

    fromCodePoint(...points) {

        let out = [];

        points.forEach(next => {

            next = Number(next);

            if (!sameValue(next, toInteger(next)) || next < 0 || next > 0x10ffff)
                throw new RangeError("Invalid code point " + next);

            if (next < 0x10000) {

                out.push(String.fromCharCode(next));

            } else {

                next -= 0x10000;
                out.push(String.fromCharCode((next >> 10) + 0xD800));
                out.push(String.fromCharCode((next % 0x400) + 0xDC00));
            }
        });

        return out.join("");
    }

});

// Repeat a string by "squaring"
function repeat(s, n) {

    if (n < 1) return "";
    if (n % 2) return repeat(s, n - 1) + s;
    let half = repeat(s, n / 2);
    return half + half;
}

class StringIterator {

    constructor(string) {

        this.string = string;
        this.current = 0;
    }

    next() {

        let s = this.string,
            i = this.current,
            len = s.length;

        if (i >= len) {

            this.current = Infinity;
            return { value: void 0, done: true };
        }

        let c = s.charCodeAt(i),
            chars = 1;

        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {

            c = s.charCodeAt(i + 1);
            chars = (c < 0xDC00 || c > 0xDFFF) ? 1 : 2;
        }

        this.current += chars;

        return { value: s.slice(i, this.current), done: false };
    }

    [Symbol.iterator]() { return this }

}

polyfill(String.prototype, {

    repeat(count) {

        assertThis(this, "String.prototype.repeat");

        let string = String(this);

        count = toInteger(count);

        if (count < 0 || count === Infinity)
            throw new RangeError("Invalid count value");

        return repeat(string, count);
    },

    startsWith(search) {

        assertThis(this, "String.prototype.startsWith");

        if (isRegExp(search))
            throw new TypeError("First argument to String.prototype.startsWith must not be a regular expression");

        let string = String(this);

        search = String(search);

        let pos = arguments.length > 1 ? arguments[1] : undefined,
            start = Math.max(toInteger(pos), 0);

        return string.slice(start, start + search.length) === search;
    },

    endsWith(search) {

        assertThis(this, "String.prototype.endsWith");

        if (isRegExp(search))
            throw new TypeError("First argument to String.prototype.endsWith must not be a regular expression");

        let string = String(this);

        search = String(search);

        let len = string.length,
            arg = arguments.length > 1 ? arguments[1] : undefined,
            pos = arg === undefined ? len : toInteger(arg),
            end = Math.min(Math.max(pos, 0), len);

        return string.slice(end - search.length, end) === search;
    },

    contains(search) {

        assertThis(this, "String.prototype.contains");

        let string = String(this),
            pos = arguments.length > 1 ? arguments[1] : undefined;

        // Somehow this trick makes method 100% compat with the spec
        return string.indexOf(search, pos) !== -1;
    },

    codePointAt(pos) {

        assertThis(this, "String.prototype.codePointAt");

        let string = String(this),
            len = string.length;

        pos = toInteger(pos);

        if (pos < 0 || pos >= len)
            return undefined;

        let a = string.charCodeAt(pos);

        if (a < 0xD800 || a > 0xDBFF || pos + 1 === len)
            return a;

        let b = string.charCodeAt(pos + 1);

        if (b < 0xDC00 || b > 0xDFFF)
            return a;

        return ((a - 0xD800) * 1024) + (b - 0xDC00) + 0x10000;
    },

    [Symbol.iterator]() {

        assertThis(this, "String.prototype[Symbol.iterator]");
        return new StringIterator(this);
    }

});

// === Array ===

class ArrayIterator {

    constructor(array, kind) {

        this.array = array;
        this.current = 0;
        this.kind = kind;
    }

    next() {

        let length = toLength(this.array.length),
            index = this.current;

        if (index >= length) {

            this.current = Infinity;
            return { value: void 0, done: true };
        }

        this.current += 1;

        switch (this.kind) {

            case "values":
                return { value: this.array[index], done: false };

            case "entries":
                return { value: [ index, this.array[index] ], done: false };

            default:
                return { value: index, done: false };
        }
    }

    [Symbol.iterator]() { return this }

}

polyfill(Array, {

    from(list) {

        list = toObject(list);

        let ctor = typeof this === "function" ? this : Array, // TODO: Always use "this"?
            map = arguments[1],
            thisArg = arguments[2],
            i = 0,
            out;

        if (map !== void 0 && typeof map !== "function")
            throw new TypeError(map + " is not a function");

        var getIter = iteratorMethod(list);

        if (getIter) {

            let iter = getIter.call(list),
                result;

            out = new ctor;

            while (result = iter.next(), !result.done) {

                out[i++] = map ? map.call(thisArg, result.value, i) : result.value;
                out.length = i;
            }

        } else {

            let len = toLength(list.length);

            out = new ctor(len);

            for (; i < len; ++i)
                out[i] = map ? map.call(thisArg, list[i], i) : list[i];

            out.length = len;
        }

        return out;
    },

    of(...items) {

        let ctor = typeof this === "function" ? this : Array;

        if (ctor === Array)
            return items;

        let len = items.length,
            out = new ctor(len);

        for (let i = 0; i < len; ++i)
            out[i] = items[i];

        out.length = len;

        return out;
    }

});

function arrayFind(obj, pred, thisArg, type) {

    let len = toLength(obj.length),
        val;

    if (typeof pred !== "function")
        throw new TypeError(pred + " is not a function");

    for (let i = 0; i < len; ++i) {

        val = obj[i];

        if (pred.call(thisArg, val, i, obj))
            return type === "value" ? val : i;
    }

    return type === "value" ? void 0 : -1;
}

polyfill(Array.prototype, {

    copyWithin(target, start) {

        let obj = toObject(this),
            len = toLength(obj.length),
            end = arguments[2];

        target = toInteger(target);
        start = toInteger(start);

        let to = target < 0 ? Math.max(len + target, 0) : Math.min(target, len),
            from = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);

        end = end !== void 0 ? toInteger(end) : len;
        end = end < 0 ? Math.max(len + end, 0) : Math.min(end, len);

        let count = Math.min(end - from, len - to),
            dir = 1;

        if (from < to && to < from + count) {

            dir = -1;
            from += count - 1;
            to += count - 1;
        }

        for (; count > 0; --count) {

            if (from in obj) obj[to] = obj[from];
            else delete obj[to];

            from += dir;
            to += dir;
        }

        return obj;
    },

    fill(value) {

        let obj = toObject(this),
            len = toLength(obj.length),
            start = toInteger(arguments[1]),
            pos = start < 0 ? Math.max(len + start, 0) : Math.min(start, len),
            end = arguments.length > 2 ? toInteger(arguments[2]) : len;

        end = end < 0 ? Math.max(len + end, 0) : Math.min(end, len);

        for (; pos < end; ++pos)
            obj[pos] = value;

        return obj;
    },

    find(pred) {

        return arrayFind(toObject(this), pred, arguments[1], "value");
    },

    findIndex(pred) {

        return arrayFind(toObject(this), pred, arguments[1], "index");
    },

    values()  { return new ArrayIterator(this, "values") },

    entries() { return new ArrayIterator(this, "entries") },

    keys()    { return new ArrayIterator(this, "keys") },

    [Symbol.iterator]() { return this.values() }

});
