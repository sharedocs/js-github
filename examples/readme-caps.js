let repo = {};
const githubName = "creationix/js-github";
const githubToken = "8fe7e5ad65814ea315daad99b6b65f2fd0e4c5aa";
require('../mixins/github-db')(repo, githubName, githubToken);
require('js-git/mixins/create-tree')(repo);
require('js-git/mixins/mem-cache')(repo);
require('js-git/mixins/read-combiner')(repo);
require('js-git/mixins/formats')(repo);
let run = require('gen-run');
run(function* () {
    const headHash = yield repo.readRef("refs/heads/master");
    const commit = yield repo.loadAs("commit", headHash);
    const tree = yield repo.loadAs("tree", commit.tree);
    const entry = tree["README.md"];
    const readme = yield repo.loadAs("text", entry.hash);
    let updates = [
        {
            path: "README.md",
            mode: entry.mode,
            content: readme.toUpperCase()
        }
    ];
    updates.base = commit.tree;
    const treeHash = yield repo.createTree(updates);
    const commitHash = yield repo.saveAs("commit", {
        tree: treeHash,
        author: {
            name: "Tim Caswell",
            email: "tim@creationix.com"
        },
        parent: headHash,
        message: "Change README.md to be all uppercase using js-github"
    });
    console.log("COMMIT", commitHash);
    const new_hash = yield repo.updateRef("refs/heads/new-branch", commitHash);
    yield repo.deleteRef("refs/heads/new-branch");
});
