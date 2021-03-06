"use strict";
var modes = require('js-git/lib/modes');
var xhr = require('../lib/xhr');
var bodec = require('bodec');
var sha1 = require('git-sha1');
var frame = require('js-git/lib/object-codec').frame;
const modeToType = {
    "040000": "tree",
    "100644": "blob",
    "100755": "blob",
    "120000": "blob",
    "160000": "commit"
};
const encoders = {
    commit: encodeCommit,
    tag: encodeTag,
    tree: encodeTree,
    blob: encodeBlob
};
const decoders = {
    commit: decodeCommit,
    tag: decodeTag,
    tree: decodeTree,
    blob: decodeBlob,
};
let typeCache = {};
const empty = bodec.create(0);
const emptyBlob = sha1(frame({ type: "blob", body: empty }));
const emptyTree = sha1(frame({ type: "tree", body: empty }));
module.exports = function (repo, root, accessToken, githubHostname) {
    let apiRequest = xhr(root, accessToken, githubHostname);
    repo.loadAs = loadAs;
    repo.saveAs = saveAs;
    repo.listRefs = listRefs;
    repo.readRef = readRef;
    repo.updateRef = updateRef;
    repo.deleteRef = deleteRef;
    repo.createTree = createTree;
    repo.hasHash = hasHash;
    function loadAs(type, hash, callback) {
        if (!callback)
            return loadAs.bind(repo, type, hash);
        if (type === "tree" && hash === emptyTree)
            return callback(null, {}, hash);
        apiRequest("GET", "/repos/:root/git/" + type + "s/" + hash, onValue);
        function onValue(err, xhr, result) {
            if (err)
                return callback(err);
            if (xhr.status < 200 || xhr.status >= 500) {
                return callback(new Error("Invalid HTTP response: " + xhr.statusCode + " " + result.message));
            }
            if (xhr.status >= 300 && xhr.status < 500)
                return callback();
            let body;
            try {
                body = decoders[type].call(repo, result);
            }
            catch (err) {
                return callback(err);
            }
            if (hashAs(type, body) !== hash) {
                if (fixDate(type, body, hash))
                    console.log(type + " repaired", hash);
                else
                    console.warn("Unable to repair " + type, hash);
            }
            typeCache[hash] = type;
            return callback(null, body, hash);
        }
    }
    function hasHash(hash, callback) {
        if (!callback)
            return hasHash.bind(repo, hash);
        let type = typeCache[hash];
        let types = type ? [type] : ["tag", "commit", "tree", "blob"];
        start();
        function start() {
            type = types.pop();
            if (!type)
                return callback(null, false);
            apiRequest("GET", "/repos/:root/git/" + type + "s/" + hash, onValue);
        }
        function onValue(err, xhr, result) {
            if (err)
                return callback(err);
            if (xhr.status < 200 || xhr.status >= 500) {
                return callback(new Error("Invalid HTTP response: " + xhr.statusCode + " " + result.message));
            }
            if (xhr.status >= 300 && xhr.status < 500)
                return start();
            typeCache[hash] = type;
            callback(null, true);
        }
    }
    function saveAs(type, body, callback) {
        if (!callback)
            return saveAs.bind(repo, type, body);
        let hash;
        try {
            hash = hashAs(type, body);
        }
        catch (err) {
            return callback(err);
        }
        typeCache[hash] = type;
        repo.hasHash(hash, function (err, has) {
            if (err)
                return callback(err);
            if (has)
                return callback(null, hash, body);
            let request;
            try {
                request = encoders[type](body);
            }
            catch (err) {
                return callback(err);
            }
            if (type === "tree" && request.tree.length === 0) {
                return callback(null, emptyTree, body);
            }
            return apiRequest("POST", "/repos/:root/git/" + type + "s", request, onWrite);
        });
        function onWrite(err, xhr, result) {
            if (err)
                return callback(err);
            if (xhr.status < 200 || xhr.status >= 300) {
                return callback(new Error("Invalid HTTP response: " + xhr.status + " " + result.message));
            }
            return callback(null, result.sha, body);
        }
    }
    function createTree(entries, callback) {
        if (!callback)
            return createTree.bind(repo, entries);
        let toDelete = entries.base && entries.filter(function (entry) {
            return !entry.mode;
        }).map(function (entry) {
            return entry.path;
        });
        let toCreate = entries.filter(function (entry) {
            return bodec.isBinary(entry.content);
        });
        if (!toCreate.length)
            return next();
        let done = false;
        let left = entries.length;
        toCreate.forEach(function (entry) {
            repo.saveAs("blob", entry.content, function (err, hash) {
                if (done)
                    return;
                if (err) {
                    done = true;
                    return callback(err);
                }
                delete entry.content;
                entry.hash = hash;
                left--;
                if (!left)
                    next();
            });
        });
        function next(err) {
            if (err)
                return callback(err);
            if (toDelete && toDelete.length) {
                return slowUpdateTree(entries, toDelete, callback);
            }
            return fastUpdateTree(entries, callback);
        }
    }
    function fastUpdateTree(entries, callback) {
        let request = { tree: entries.map(mapTreeEntry) };
        if (entries.base)
            request.base_tree = entries.base;
        apiRequest("POST", "/repos/:root/git/trees", request, onWrite);
        function onWrite(err, xhr, result) {
            if (err)
                return callback(err);
            if (xhr.status < 200 || xhr.status >= 300) {
                return callback(new Error("Invalid HTTP response: " + xhr.status + " " + result.message));
            }
            return callback(null, result.sha, decoders.tree(result));
        }
    }
    function slowUpdateTree(entries, toDelete, callback) {
        callback = singleCall(callback);
        let root = entries.base;
        let left = 0;
        let parents = {};
        toDelete.forEach(function (path) {
            let parentPath = path.substr(0, path.lastIndexOf("/"));
            let parent = parents[parentPath] || (parents[parentPath] = {
                add: {}, del: []
            });
            let name = path.substr(path.lastIndexOf("/") + 1);
            parent.del.push(name);
        });
        let other = entries.filter(function (entry) {
            if (!entry.mode)
                return false;
            let parentPath = entry.path.substr(0, entry.path.lastIndexOf("/"));
            let parent = parents[parentPath];
            if (!parent)
                return true;
            let name = entry.path.substr(entry.path.lastIndexOf("/") + 1);
            if (entry.hash) {
                parent.add[name] = {
                    mode: entry.mode,
                    hash: entry.hash
                };
                return false;
            }
            left++;
            repo.saveAs("blob", entry.content, function (err, hash) {
                if (err)
                    return callback(err);
                parent.add[name] = {
                    mode: entry.mode,
                    hash: hash
                };
                if (!--left)
                    onParents();
            });
            return false;
        });
        if (!left)
            onParents();
        function onParents() {
            Object.keys(parents).forEach(function (parentPath) {
                left++;
                repo.pathToEntry(root, parentPath, function (err, entry) {
                    if (err)
                        return callback(err);
                    let tree = entry.tree;
                    let commands = parents[parentPath];
                    commands.del.forEach(function (name) {
                        delete tree[name];
                    });
                    for (let name in commands.add) {
                        tree[name] = commands.add[name];
                    }
                    repo.saveAs("tree", tree, function (err, hash, tree) {
                        if (err)
                            return callback(err);
                        other.push({
                            path: parentPath,
                            hash: hash,
                            mode: modes.tree
                        });
                        if (!--left) {
                            other.base = entries.base;
                            if (other.length === 1 && other[0].path === "") {
                                return callback(null, hash, tree);
                            }
                            fastUpdateTree(other, callback);
                        }
                    });
                });
            });
        }
    }
    function readRef(ref, callback) {
        if (!callback)
            return readRef.bind(repo, ref);
        if (ref === "HEAD")
            ref = "refs/heads/master";
        if (!(/^refs\//).test(ref)) {
            return callback(new TypeError("Invalid ref: " + ref));
        }
        return apiRequest("GET", "/repos/:root/git/" + ref, onRef);
        function onRef(err, xhr, result) {
            if (err)
                return callback(err);
            if (xhr.status === 404)
                return callback();
            if (xhr.status < 200 || xhr.status >= 300) {
                return callback(new Error("Invalid HTTP response: " + xhr.status + " " + result.message));
            }
            return callback(null, result.object.sha);
        }
    }
    function deleteRef(ref, callback) {
        if (!callback)
            return deleteRef.bind(repo, ref);
        if (ref === "HEAD")
            ref = "refs/heads/master";
        if (!(/^refs\//).test(ref)) {
            return callback(new TypeError("Invalid ref: " + ref));
        }
        return apiRequest("DELETE", "/repos/:root/git/" + ref, onRef);
        function onRef(err, xhr, result) {
            if (err)
                return callback(err);
            if (xhr.status === 404)
                return callback();
            if (xhr.status < 200 || xhr.status >= 300) {
                return callback(new Error("Invalid HTTP response: " + xhr.status + " " + result.message));
            }
            return callback(null, null);
        }
    }
    function listRefs(filter, callback) {
        if (!callback)
            return listRefs.bind(repo, filter);
        filter = filter ? '/' + filter : '';
        return apiRequest("GET", "/repos/:root/git/refs" + filter, onResult);
        function onResult(err, xhr, result) {
            if (err)
                return callback(err);
            if (xhr.status === 404)
                return callback();
            if (xhr.status < 200 || xhr.status >= 300) {
                return callback(new Error("Invalid HTTP response: " + xhr.status + " " + result.message));
            }
            callback(null, result.map(function (entry) { return entry.ref; }));
        }
    }
    function updateRef(ref, hash, callback, force) {
        if (!callback)
            return updateRef.bind(repo, ref, hash);
        if (!(/^refs\//).test(ref)) {
            return callback(new Error("Invalid ref: " + ref));
        }
        return apiRequest("PATCH", "/repos/:root/git/" + ref, {
            sha: hash,
            force: !!force
        }, onResult);
        function onResult(err, xhr, result) {
            if (err)
                return callback(err);
            if (xhr.status === 422 && result.message === "Reference does not exist") {
                return apiRequest("POST", "/repos/:root/git/refs", {
                    ref: ref,
                    sha: hash
                }, onResult);
            }
            if (xhr.status < 200 || xhr.status >= 300) {
                return callback(new Error("Invalid HTTP response: " + xhr.status + " " + result.message));
            }
            if (err)
                return callback(err);
            callback(null, hash);
        }
    }
};
function fixDate(type, value, hash) {
    if (type !== "commit" && type !== "tag")
        return;
    let clone = JSON.parse(JSON.stringify(value));
    for (let x = 0; x < 3; x++) {
        for (let i = -720; i < 720; i += 30) {
            if (type === "commit") {
                clone.author.date.offset = i;
                clone.committer.date.offset = i;
            }
            else if (type === "tag") {
                clone.tagger.date.offset = i;
            }
            if (hash !== hashAs(type, clone))
                continue;
            value.message = clone.message;
            if (type === "commit") {
                value.author.date.offset = clone.author.date.offset;
                value.committer.date.offset = clone.committer.date.offset;
            }
            else if (type === "tag") {
                value.tagger.date.offset = clone.tagger.date.offset;
            }
            return true;
        }
        clone.message += "\n";
    }
    return false;
}
function mapTreeEntry(entry) {
    if (!entry.mode)
        throw new TypeError("Invalid entry");
    let mode = modeToString(entry.mode);
    let item = {
        path: entry.path,
        mode: mode,
        type: modeToType[mode]
    };
    if (entry.content === "")
        entry.hash = emptyBlob;
    if (entry.hash)
        item.sha = entry.hash;
    else
        item.content = entry.content;
    return item;
}
function encodeCommit(commit) {
    let out = {};
    out.message = commit.message;
    out.tree = commit.tree;
    if (commit.parents)
        out.parents = commit.parents;
    else if (commit.parent)
        out.parents = [commit.parent];
    else
        commit.parents = [];
    if (commit.author)
        out.author = encodePerson(commit.author);
    if (commit.committer)
        out.committer = encodePerson(commit.committer);
    return out;
}
function encodeTag(tag) {
    return {
        tag: tag.tag,
        message: tag.message,
        object: tag.object,
        tagger: encodePerson(tag.tagger)
    };
}
function encodePerson(person) {
    return {
        name: person.name,
        email: person.email,
        date: encodeDate(person.date)
    };
}
function encodeTree(tree) {
    return {
        tree: Object.keys(tree).map(function (name) {
            let entry = tree[name];
            let mode = modeToString(entry.mode);
            return {
                path: name,
                mode: mode,
                type: modeToType[mode],
                sha: entry.hash
            };
        })
    };
}
function encodeBlob(blob) {
    if (typeof blob === "string")
        return {
            content: bodec.encodeUtf8(blob),
            encoding: "utf-8"
        };
    else if (bodec.isBinary(blob))
        return {
            content: bodec.toBase64(blob),
            encoding: "base64"
        };
    throw new TypeError("Invalid blob type, must be binary or string");
}
function modeToString(mode) {
    let string = mode.toString(8);
    if (string.length === 5)
        string = "0" + string;
    return string;
}
function decodeCommit(result) {
    return {
        tree: result.tree.sha,
        parents: result.parents.map(function (object) {
            return object.sha;
        }),
        author: pickPerson(result.author),
        committer: pickPerson(result.committer),
        message: result.message
    };
}
function decodeTag(result) {
    return {
        object: result.object.sha,
        type: result.object.type,
        tag: result.tag,
        tagger: pickPerson(result.tagger),
        message: result.message
    };
}
function decodeTree(result) {
    let tree = {};
    result.tree.forEach(function (entry) {
        tree[entry.path] = {
            mode: parseInt(entry.mode, 8),
            hash: entry.sha
        };
    });
    return tree;
}
function decodeBlob(result) {
    if (result.encoding === 'base64') {
        return bodec.fromBase64(result.content.replace(/\n/g, ''));
    }
    else if (result.encoding === 'utf-8') {
        return bodec.fromUtf8(result.content);
    }
    throw new Error("Unknown blob encoding: " + result.encoding);
}
function pickPerson(person) {
    return {
        name: person.name,
        email: person.email,
        date: parseDate(person.date)
    };
}
function parseDate(str) {
    let match = str.match(/(-?)([0-9]{2}):([0-9]{2})$/);
    let date = new Date(str);
    let timezoneOffset = 0;
    if (match) {
        timezoneOffset = (match[1] === "-" ? 1 : -1) * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10));
    }
    return {
        seconds: date.valueOf() / 1000,
        offset: timezoneOffset
    };
}
function encodeDate(date) {
    let seconds = date.seconds - (date.offset) * 60;
    let d = new Date(seconds * 1000);
    let string = d.toISOString();
    let neg = "+";
    let offset = date.offset;
    if (offset <= 0)
        offset = -offset;
    else
        neg = "-";
    let hours = (date.offset / 60) | 0;
    let minutes = date.offset % 60;
    string = string.substring(0, string.lastIndexOf(".")) +
        neg + twoDigit(hours) + ":" + twoDigit(minutes);
    return string;
}
[
    { offset: 300, seconds: 1401938626 },
    { offset: 400, seconds: 1401938626 }
].forEach(function (date) {
    let verify = parseDate(encodeDate(date));
    if (verify.seconds !== date.seconds || verify.offset !== date.offset) {
        throw new Error("Verification failure testing date encoding");
    }
});
function twoDigit(num) {
    if (num < 10)
        return "0" + num;
    return "" + num;
}
function singleCall(callback) {
    let done = false;
    return function () {
        if (done)
            return console.warn("Discarding extra callback");
        done = true;
        return callback.apply(this, arguments);
    };
}
function hashAs(type, body) {
    let buffer = frame({ type: type, body: body });
    return sha1(buffer);
}
