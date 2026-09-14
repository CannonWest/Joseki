import test from 'node:test';
import assert from 'node:assert/strict';
import { SHIPPED_EXAMPLE_IDS } from '@joseki/shared';
import {
  deleteFolderWarning,
  deleteWorkflowWarning,
  describeFolder,
  describeWorkflow,
  missingExamples,
  moveTargets
} from '../src/workflows/browse';

test('a workflow row says how big it is and how often it has run', () => {
  assert.equal(describeWorkflow({ nodeCount: 7, runCount: 10 }), '7 nodes · 10 runs');
  assert.equal(describeWorkflow({ nodeCount: 1, runCount: 1 }), '1 node · 1 run');
  assert.equal(describeWorkflow({ nodeCount: 3, runCount: 0 }), '3 nodes · never run');
});

test('a folder row says what it holds, all the way down', () => {
  assert.equal(describeFolder({ workflowCount: 0, folderCount: 0 }), 'empty');
  assert.equal(describeFolder({ workflowCount: 2, folderCount: 0 }), '2 workflows');
  assert.equal(describeFolder({ workflowCount: 1, folderCount: 0 }), '1 workflow');
  assert.equal(describeFolder({ workflowCount: 0, folderCount: 1 }), '1 folder');
  assert.equal(describeFolder({ workflowCount: 3, folderCount: 2 }), '3 workflows in 2 folders');
});

test('deleting a workflow warns about its runs only when it has any', () => {
  assert.equal(deleteWorkflowWarning({ name: 'Draft', runCount: 0 }), 'Delete "Draft"?');
  assert.equal(deleteWorkflowWarning({ name: 'Draft', runCount: 1 }), 'Delete "Draft"? Its 1 run goes with it.');
  assert.equal(deleteWorkflowWarning({ name: 'Draft', runCount: 10 }), 'Delete "Draft"? Its 10 runs go with it.');
});

test('deleting a folder says what goes with it', () => {
  assert.equal(deleteFolderWarning({ name: 'Empty', workflowCount: 0, folderCount: 0 }), 'Delete "Empty"?');
  assert.equal(
    deleteFolderWarning({ name: 'Examples', workflowCount: 2, folderCount: 0 }),
    'Delete "Examples" and the 2 workflows in it? Their runs go too.'
  );
  assert.equal(
    deleteFolderWarning({ name: 'Clients', workflowCount: 0, folderCount: 3 }),
    'Delete "Clients" and the 3 folders in it?'
  );
});

test('move targets are the root and every folder, indented by depth, with the current place disabled', () => {
  const folders = [
    { path: 'Examples', createdAt: 1 },
    { path: 'Clients/Acme', createdAt: 1 },
    { path: 'Clients', createdAt: 1 }
  ];
  const targets = moveTargets(folders, { currentFolder: 'Clients' });

  assert.deepEqual(
    targets.map((t) => [t.path, t.name, t.depth, t.disabled]),
    [
      ['', 'Workflows', 0, false],
      ['Clients', 'Clients', 1, true],
      ['Clients/Acme', 'Acme', 2, false],
      ['Examples', 'Examples', 1, false]
    ]
  );
});

test('a folder being moved cannot be offered itself or anything under it', () => {
  const folders = [
    { path: 'Clients', createdAt: 1 },
    { path: 'Clients/Acme', createdAt: 1 },
    { path: 'Clients2', createdAt: 1 }
  ];
  const targets = moveTargets(folders, { currentFolder: '', movingFolder: 'Clients' });
  const disabled = targets.filter((t) => t.disabled).map((t) => t.path);

  assert.deepEqual(disabled, ['', 'Clients', 'Clients/Acme']);
  assert.equal(targets.find((t) => t.path === 'Clients2')?.disabled, false, 'a shared prefix is not inside');
});

test('the examples missing from the library are the ones Restore would bring back', () => {
  assert.deepEqual(missingExamples([]), [...SHIPPED_EXAMPLE_IDS]);
  assert.deepEqual(missingExamples(SHIPPED_EXAMPLE_IDS.map((id) => ({ id }))), []);
  const [first, ...rest] = SHIPPED_EXAMPLE_IDS;
  assert.deepEqual(missingExamples([{ id: first }, { id: 'mine' }]), rest);
});
