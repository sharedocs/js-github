const isNode = typeof process === 'object' &&
    typeof process.versions === 'object' &&
    process.versions.node &&
    process['__atom_type'] !== "renderer";
if (isNode) {
    const nodeRequire = require;
    exports = nodeRequire('./xhr-node.js');
}
else {
    exports = function (root, accessToken, githubHostname) {
        var timeout = 2000;
        githubHostname = (githubHostname || 'https://api.github.com');
        return request;
        function request(method, url, body, callback) {
            if (typeof body === "function") {
                callback = body;
                body = undefined;
            }
            else if (!callback)
                return request.bind(null, method, url, body);
            url = url.replace(":root", root);
            var done = false;
            var json;
            var xhr = new XMLHttpRequest();
            xhr.timeout = timeout;
            xhr.open(method, githubHostname + url, true);
            xhr.setRequestHeader("Authorization", "token " + accessToken);
            if (body) {
                try {
                    json = JSON.stringify(body);
                }
                catch (err) {
                    return callback(err);
                }
            }
            xhr.ontimeout = onTimeout;
            xhr.onerror = function () {
                callback(new Error("Error requesting " + url));
            };
            xhr.onreadystatechange = onReadyStateChange;
            xhr.send(json);
            function onReadyStateChange() {
                if (done)
                    return;
                if (xhr.readyState !== 4)
                    return;
                if (!xhr.status)
                    return setTimeout(onReadyStateChange, 0);
                done = true;
                var response = { message: xhr.responseText };
                if (xhr.responseText) {
                    try {
                        response = JSON.parse(xhr.responseText);
                    }
                    catch (err) { }
                }
                xhr.responseBody = response;
                return callback(null, xhr, response);
            }
            function onTimeout() {
                if (done)
                    return;
                if (timeout < 8000) {
                    timeout *= 2;
                    return request(method, url, body, callback);
                }
                done = true;
                callback(new Error("Timeout requesting " + url));
            }
        }
    };
}
