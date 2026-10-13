const fs = require('fs');
const path = require('path');
// Compiled code lives in dist/src; use the same data and public files as source runs.
const parent = path.resolve(__dirname, '..');
module.exports = fs.existsSync(path.join(parent, 'package.json')) ? parent : path.resolve(parent, '..');
