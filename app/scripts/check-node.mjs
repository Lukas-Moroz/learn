// Learn uses Node's built-in SQLite (node:sqlite), available without flags from Node 22.13.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Learn needs Node 22.13 or newer (you have ${process.version}). With nvm: nvm install 22 && nvm use 22`);
  process.exit(1);
}
