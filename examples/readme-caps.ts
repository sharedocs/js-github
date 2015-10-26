let repo: any = {};

// This only works for normal repos.  Github doesn't allow access to gists as
// far as I can tell.
const githubName = "creationix/js-github";

// Your user can generate these manually at https://github.com/settings/tokens/new
// Or you can use an oauth flow to get a token for the user.
const githubToken = "8fe7e5ad65814ea315daad99b6b65f2fd0e4c5aa";

// Mixin the main library using github to provide the following:
// - repo.loadAs(type, hash) => value
// - repo.saveAs(type, value) => hash
// - repo.readRef(ref) => hash
// - repo.updateRef(ref, hash) => hash
// - repo.createTree(entries) => hash
// - repo.hasHash(hash) => has
require('../mixins/github-db')(repo, githubName, githubToken);


// Github has this built-in, but it's currently very buggy so we replace with
// the manual implementation in js-git.
require('js-git/mixins/create-tree')(repo);

// Cache everything except blobs over 100 bytes in memory.
// This makes path-to-hash lookup a sync operation in most cases.
require('js-git/mixins/mem-cache')(repo);

// Combine concurrent read requests for the same hash
require('js-git/mixins/read-combiner')(repo);

// Add in value formatting niceties.  Also adds text and array types.
require('js-git/mixins/formats')(repo);

// I'm using generator syntax, but callback style also works.
// See js-git main docs for more details.
let run = require('gen-run');
run(function* () {
    const headHash = yield repo.readRef("refs/heads/master");
    const commit = yield repo.loadAs("commit", headHash);
    const tree = yield repo.loadAs("tree", commit.tree);
    const entry = tree["README.md"];
    const readme = yield repo.loadAs("text", entry.hash);

    // Build the updates array
    let updates: any = [
        {
            path: "README.md", // Update the existing entry
            mode: entry.mode,  // Preserve the mode (it might have been executible)
            content: readme.toUpperCase() // Write the new content
        }
    ];
    // Based on the existing tree, we only want to update, not replace.
    updates.base = commit.tree;

    // Create the new file and the updated tree.
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

    // Now we can browse to this commit by hash, but it's still not in master.
    // We need to update the ref to point to this new commit.
    console.log("COMMIT", commitHash)

    // Save it to a new branch (Or update existing one)
    const new_hash = yield repo.updateRef("refs/heads/new-branch", commitHash);

    // And delete this new branch:
    yield repo.deleteRef("refs/heads/new-branch");
});
