const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
new vm.Script(inline); // Check the full application, not only the tested functions.
const syncSource = inline.split('// BEGIN STATE SYNC:')[1].split('// END STATE SYNC')[0];
const createStateSync = vm.runInNewContext('// ' + syncSource + '\ncreateStateSync', { setTimeout, clearTimeout });
const copy = value => JSON.parse(JSON.stringify(value));

function setup(options = {}) {
  const box = { state: null, draft: options.draft || null, events: [], writes: [] };
  const sync = createStateSync({
    read: options.read || (async () => ({ state: { notes: 'server' }, revision: 1 })),
    write: options.write || (async (state, revision) => {
      box.writes.push({ state: copy(state), revision });
      return { ok: true, revision: revision + 1 };
    }),
    apply: state => { box.state = copy(state); },
    changed: info => box.events.push(copy(info)),
    drafts: {
      read: () => box.draft,
      save: draft => { if (options.storageFails) throw new Error('quota'); box.draft = copy(draft); },
      clear: () => { if (options.storageFails) throw new Error('quota'); box.draft = null; }
    },
    debounceMs: 5
  });
  return { sync, box };
}

async function until(condition) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail('Condition was not reached');
}

test('two overlapping edits in one tab are serialized with successive revisions', async () => {
  const writes = [];
  let finishFirst;
  const { sync } = setup({ write: async (state, revision) => {
    writes.push({ state: copy(state), revision });
    if (writes.length === 1) await new Promise(resolve => { finishFirst = resolve; });
    return { ok: true, revision: revision + 1 };
  } });
  await sync.reload(true);
  sync.enqueue({ notes: 'first' });
  await until(() => writes.length === 1);
  sync.enqueue({ notes: 'second' });
  sync.enqueue({ notes: 'latest' });
  assert.equal(writes.length, 1);
  finishFirst();
  await until(() => sync.info().status === 'saved');
  assert.deepEqual(writes, [
    { state: { notes: 'first' }, revision: 1 },
    { state: { notes: 'latest' }, revision: 2 }
  ]);
  assert.equal(sync.info().revision, 3);
});

test('conflict preserves the newest local edit and stops automatic/retry writes', async () => {
  let calls = 0;
  const { sync, box } = setup({ write: async () => {
    calls++;
    const error = new Error('conflict'); error.status = 409; throw error;
  } });
  await sync.reload();
  sync.enqueue({ notes: 'mine' });
  await until(() => sync.info().status === 'conflict');
  sync.enqueue({ notes: 'newer unsaved draft' });
  await sync.retry();
  await delay(20);
  assert.equal(calls, 1);
  assert.deepEqual(box.draft.state, { notes: 'newer unsaved draft' });
  assert.equal(sync.info().dirty, true);
  assert.equal(await sync.reload(), true);
  assert.deepEqual(box.state, { notes: 'server' });
  assert.equal(sync.info().dirty, false);
  assert.equal(box.draft, null);
});

test('network error preserves edits; an explicit retry writes the latest draft', async () => {
  let failing = true;
  const writes = [];
  const { sync, box } = setup({ write: async (state, revision) => {
    writes.push(copy(state));
    if (failing) throw new Error('offline');
    return { ok: true, revision: revision + 1 };
  } });
  await sync.reload();
  sync.enqueue({ notes: 'offline edit' });
  await until(() => sync.info().status === 'error');
  sync.enqueue({ notes: 'latest offline edit' });
  assert.equal(writes.length, 1);
  assert.equal(box.draft.state.notes, 'latest offline edit');
  failing = false;
  assert.equal(await sync.retry(), true);
  assert.equal(sync.info().status, 'saved');
  assert.equal(sync.info().dirty, false);
  assert.equal(writes.at(-1).notes, 'latest offline edit');
});

test('lost acknowledgement does not silently overwrite newer server data', async () => {
  let version = 1;
  const { sync, box } = setup({ write: async (state, base) => {
    if (base !== version) { const error = new Error('stale'); error.status = 409; throw error; }
    version++;
    throw new Error('response lost after commit');
  } });
  await sync.reload();
  sync.enqueue({ notes: 'uncertain save' });
  await until(() => sync.info().status === 'error');
  await sync.retry();
  assert.equal(sync.info().status, 'conflict');
  assert.equal(version, 2);
  assert.equal(box.draft.state.notes, 'uncertain save');
});

test('startup failure disables editing instead of importing a browser cache', async () => {
  const { sync, box } = setup({ read: async () => { throw new Error('HTTP 500'); } });
  assert.equal(await sync.reload(true), false);
  assert.equal(sync.info().ready, false);
  assert.equal(sync.enqueue({ notes: 'must not save defaults' }), false);
  assert.equal(box.writes.length, 0);
});

test('a failed refresh keeps the pending draft and current revision', async () => {
  let broken = false;
  const { sync, box } = setup({ read: async () => {
    if (broken) throw new Error('timeout');
    return { state: { notes: 'server' }, revision: 4 };
  } });
  await sync.reload();
  sync.enqueue({ notes: 'keep me' });
  broken = true;
  assert.equal(await sync.reload(), false);
  assert.equal(sync.info().revision, 4);
  assert.equal(box.draft.state.notes, 'keep me');
  assert.equal(sync.info().dirty, true);
  assert.equal(box.writes.length, 0);
});

test('reloading a tab restores its pending draft without automatically sending it', async () => {
  const { sync, box } = setup({ draft: { baseRevision: 1, state: { notes: 'recovered' } } });
  await sync.reload(true);
  assert.equal(sync.info().status, 'recovered');
  assert.equal(box.state.notes, 'recovered');
  await delay(20);
  assert.equal(box.writes.length, 0);
  await sync.retry();
  assert.equal(sync.info().status, 'saved');
});

test('an older recovered draft enters conflict mode; an empty server starts empty', async () => {
  const recovered = setup({ draft: { baseRevision: 0, state: { notes: 'old' } } });
  await recovered.sync.reload(true);
  assert.equal(recovered.sync.info().status, 'conflict');
  const empty = setup({ read: async () => ({ state: null, revision: 0 }) });
  await empty.sync.reload(true);
  assert.deepEqual(empty.box.state, {});
  assert.equal(empty.sync.info().revision, 0);
});

test('session storage quota errors are reported and the draft stays in memory', async () => {
  const { sync } = setup({ storageFails: true, write: async () => { throw new Error('offline'); } });
  await sync.reload();
  sync.enqueue({ notes: 'memory only' });
  await until(() => sync.info().status === 'error');
  assert.equal(sync.info().draftStored, false);
  assert.equal(sync.info().dirty, true);
});

test('a pending draft remains readable when the tab reloads while offline', async () => {
  const { sync, box } = setup({
    read: async () => { throw new Error('offline'); },
    draft: { baseRevision: 3, state: { notes: 'offline recovery' } }
  });
  assert.equal(await sync.reload(true), false);
  assert.equal(sync.info().status, 'error');
  assert.equal(sync.info().ready, true);
  assert.equal(sync.info().dirty, true);
  assert.equal(sync.info().revision, 3);
  assert.equal(box.state.notes, 'offline recovery');
  assert.equal(box.writes.length, 0);
});

test('malformed success response is not reported as saved', async () => {
  const { sync } = setup({ write: async () => ({ ok: true }) });
  await sync.reload();
  sync.enqueue({ notes: 'unconfirmed' });
  await until(() => sync.info().status === 'error');
  assert.equal(sync.info().dirty, true);
});
