const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ROOT_FOLDER,
  EXAMPLES_FOLDER,
  ancestorFolders,
  breadcrumbs,
  childFolder,
  folderName,
  folderNameError,
  folderSegments,
  isWithinFolder,
  normalizeFolderPath,
  parentFolder,
} = require('../dist/folders.js');

test('the root is the empty path: no segments, no name, its own parent', () => {
  assert.equal(ROOT_FOLDER, '');
  assert.deepEqual(folderSegments(ROOT_FOLDER), []);
  assert.equal(folderName(ROOT_FOLDER), '');
  assert.equal(parentFolder(ROOT_FOLDER), ROOT_FOLDER);
});

test('a path is read segment by segment', () => {
  assert.deepEqual(folderSegments('Clients/Acme/2026'), ['Clients', 'Acme', '2026']);
  assert.equal(folderName('Clients/Acme/2026'), '2026');
  assert.equal(parentFolder('Clients/Acme/2026'), 'Clients/Acme');
  assert.equal(parentFolder('Clients'), ROOT_FOLDER);
});

test('a child of the root is a bare name; deeper, the separator goes in', () => {
  assert.equal(childFolder(ROOT_FOLDER, 'Examples'), 'Examples');
  assert.equal(childFolder('Clients', 'Acme'), 'Clients/Acme');
});

test('everything is within the root; a folder is within itself and its ancestors, and no sibling', () => {
  assert.equal(isWithinFolder(ROOT_FOLDER, ROOT_FOLDER), true);
  assert.equal(isWithinFolder('Clients/Acme', ROOT_FOLDER), true);
  assert.equal(isWithinFolder('Clients', 'Clients'), true);
  assert.equal(isWithinFolder('Clients/Acme', 'Clients'), true);
  // A shared prefix is not an ancestor: "Clients2" is beside "Clients", not under it.
  assert.equal(isWithinFolder('Clients2', 'Clients'), false);
  assert.equal(isWithinFolder('Clients', 'Clients/Acme'), false);
});

test('a folder name is one segment, not blank, and not a name the filesystem reserves', () => {
  assert.equal(folderNameError('Examples'), null);
  assert.equal(folderNameError('Q3 drafts (2026)'), null);
  assert.match(folderNameError(''), /needs a name/);
  assert.match(folderNameError('   '), /needs a name/);
  assert.match(folderNameError(' padded'), /start or end with a space/);
  assert.match(folderNameError('.'), /not a name/);
  assert.match(folderNameError('..'), /not a name/);
  assert.match(folderNameError('a/b'), /slash/);
  assert.match(folderNameError('a\\b'), /slash/);
  assert.match(folderNameError('x'.repeat(81)), /at most 80/);
});

test('a typed path is made canonical: trimmed, stray slashes dropped, backslashes read as slashes', () => {
  assert.deepEqual(normalizeFolderPath('Clients/Acme'), { path: 'Clients/Acme' });
  assert.deepEqual(normalizeFolderPath('/Clients//Acme/'), { path: 'Clients/Acme' });
  assert.deepEqual(normalizeFolderPath(' Clients / Acme '), { path: 'Clients/Acme' });
  assert.deepEqual(normalizeFolderPath('Clients\\Acme'), { path: 'Clients/Acme' });
  assert.deepEqual(normalizeFolderPath(''), { path: ROOT_FOLDER });
  assert.deepEqual(normalizeFolderPath('/'), { path: ROOT_FOLDER });
  // Nothing given means the root, which is where a workflow goes by default.
  assert.deepEqual(normalizeFolderPath(undefined), { path: ROOT_FOLDER });
  assert.deepEqual(normalizeFolderPath(null), { path: ROOT_FOLDER });
});

test('a path with a segment that cannot be a name says which', () => {
  const dots = normalizeFolderPath('Clients/../Secrets');
  assert.ok('error' in dots, 'the up-reference must be refused');
  assert.match(dots.error, /".." is not a name/);
  assert.match(dots.error, /Clients\/\.\.\/Secrets/, 'the error names what was typed');

  const notText = normalizeFolderPath(42);
  assert.ok('error' in notText);
  assert.match(notText.error, /must be a string/);
});

test('the ancestors of a path run from nearest the root down, and the root itself is not one', () => {
  assert.deepEqual(ancestorFolders(ROOT_FOLDER), []);
  assert.deepEqual(ancestorFolders('Clients'), ['Clients']);
  assert.deepEqual(ancestorFolders('Clients/Acme/2026'), ['Clients', 'Clients/Acme', 'Clients/Acme/2026']);
});

test('breadcrumbs start at the root and name each folder on the way', () => {
  assert.deepEqual(breadcrumbs(ROOT_FOLDER), [{ path: '', name: 'Workflows' }]);
  assert.deepEqual(breadcrumbs('Clients/Acme'), [
    { path: '', name: 'Workflows' },
    { path: 'Clients', name: 'Clients' },
    { path: 'Clients/Acme', name: 'Acme' },
  ]);
  assert.equal(breadcrumbs(EXAMPLES_FOLDER, 'Home')[0].name, 'Home');
});
