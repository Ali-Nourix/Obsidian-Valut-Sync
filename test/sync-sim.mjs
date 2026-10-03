/**
 * Whole devices syncing through an in-memory server: edits travel both ways,
 * concurrent edits merge or leave a conflict copy, deletes and renames
 * propagate, nothing loops, and a device that crashes at any point of a
 * cycle finishes cleanly on the next start. The suite runs twice, the second
 * time with end-to-end encryption, and then checks the server saw no plain text.
 */
import { checker } from './harness/load.mjs';
import { lib, makeWorld, device, settle, snapshot, assertConverged, serverPaths } from './harness/world.mjs';

const { utf8, isConflictCopy, BackendError, CrashError } = lib;
const { eq, ok, count } = checker();

const conflictCopies = (dev) => Object.keys(snapshot(dev)).filter(isConflictCopy);

async function suite(encrypted) {
  const tag = encrypted ? '[encrypted] ' : '';
  const scenario = async (name, fn) => {
    const world = await makeWorld({ encrypted });
    await fn(world, `${tag}${name}`);
  };

  await scenario('edit travels from A to B and back', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    A.write('Inbox/idea.md', '# Idea\n');
    A.write('assets/photo.png', '\x89PNG fake');
    await settle([A, B]);
    eq(B.read('Inbox/idea.md'), '# Idea\n', `${t}: B received the note`);
    eq(B.read('assets/photo.png'), '\x89PNG fake', `${t}: B received the attachment`);
    B.write('Inbox/idea.md', '# Idea\n\nMore from B\n');
    await settle([A, B]);
    eq(A.read('Inbox/idea.md'), '# Idea\n\nMore from B\n', `${t}: A received B's edit`);
    assertConverged(world, [A, B], eq, t);
  });

  await scenario('relay: the server keeps nothing once every device has it', async (world, t) => {
    const A = device(world, 'A');
    A.write('alone.md', 'only me\n');
    A.write('pic.png', 'binary');
    await A.sync();
    eq(world.server.calls.putBlob, 0, `${t}: a device alone uploads no content`);
    eq(world.server.liveRows(world.vaultId).length, 2, `${t}: only the index`);

    const B = device(world, 'B');
    const first = await B.sync();
    eq(first.waiting, 2, `${t}: a new device asks for what it lacks`);
    const served = await A.sync();
    eq(served.served, 2, `${t}: the other device sends it on its next sync`);
    ok(world.server.blobCount(world.vaultId) > 0, `${t}: the content is on the server only while in transit`);
    await B.sync();
    eq(B.read('alone.md'), 'only me\n', `${t}: B received it`);
    await A.sync();
    eq(world.server.blobCount(world.vaultId), 0, `${t}: delivered, then deleted from the server`);

    B.write('alone.md', 'only me\nand B\n');
    await B.sync();
    eq(world.server.blobCount(world.vaultId), 1, `${t}: an edit goes up for A`);
    await A.sync();
    eq(A.read('alone.md'), 'only me\nand B\n', `${t}: A has the edit`);
    eq(world.server.blobCount(world.vaultId), 0, `${t}: and the server is empty again`);

    const C = device(world, 'C');
    await settle([C, A, B]);
    eq(C.read('pic.png'), 'binary', `${t}: a third device is filled by the others`);
    eq(world.server.blobCount(world.vaultId), 0, `${t}: leaving nothing behind`);
    assertConverged(world, [A, B, C], eq, t);
  });

  await scenario('relay: merging needs no copy on the server', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    A.write('m.md', '1\n2\n3\n4\n5\n');
    await settle([A, B]);
    eq(world.server.blobCount(world.vaultId), 0, `${t}: the server holds no version of the note`);
    A.write('m.md', '1 A\n2\n3\n4\n5\n');
    B.write('m.md', '1\n2\n3\n4\n5 B\n');
    await settle([A, B]);
    eq(B.read('m.md'), '1 A\n2\n3\n4\n5 B\n', `${t}: merged from each device's own base copy`);
    eq(conflictCopies(B), [], `${t}: without a conflict copy`);
    eq(world.server.blobCount(world.vaultId), 0, `${t}: and nothing left on the server`);
  });

  await scenario('relay: a device away for over 30 days is forgotten, then catches up', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    A.write('x.md', 'x\n');
    await settle([A, B]);
    world.clock.tick(31 * 24 * 3600_000);
    A.write('x.md', 'x\nwhile B was away\n');
    A.write('new.md', 'new\n');
    await A.sync();
    eq(world.server.blobCount(world.vaultId), 0, `${t}: nothing is held for a device gone that long`);
    const back = await B.sync();
    eq(back.waiting, 2, `${t}: B asks for what changed`);
    await settle([A, B]);
    eq(B.read('x.md'), 'x\nwhile B was away\n', `${t}: and gets it from A`);
    eq(world.server.blobCount(world.vaultId), 0, `${t}: the server is empty again`);
  });

  await scenario('a downloaded file is not uploaded again', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    for (let i = 0; i < 5; i++) A.write(`n${i}.md`, `note ${i}\n`);
    await settle([A, B]);
    const commits = world.server.calls.commit;
    const puts = world.server.calls.putBlob;
    for (let i = 0; i < 3; i++) {
      const report = await B.sync();
      eq(report.uploaded + report.downloaded, 0, `${t}: quiet cycle ${i} moves nothing`);
    }
    eq(world.server.calls.commit, commits, `${t}: no commits after downloading`);
    eq(world.server.calls.putBlob, puts, `${t}: no uploads after downloading`);
    world.clock.tick(5000);
    eq(B.engine.isOwnWrite('n1.md'), false, `${t}: own-write window has passed`);
  });

  await scenario('concurrent edits to different lines merge', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    A.write('todo.md', 'one\ntwo\nthree\nfour\nfive\n');
    await settle([A, B]);
    A.write('todo.md', 'ONE\ntwo\nthree\nfour\nfive\n');
    B.write('todo.md', 'one\ntwo\nthree\nfour\nFIVE\n');
    const reports = await settle([A, B]);
    eq(A.read('todo.md'), 'ONE\ntwo\nthree\nfour\nFIVE\n', `${t}: merged on A`);
    eq(conflictCopies(A), [], `${t}: no conflict copy`);
    ok(reports.some((r) => r.merged.length), `${t}: reported as a merge`);
    assertConverged(world, [A, B], eq, t);
  });

  await scenario('both devices append to a daily note', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    A.write('Daily/2026-10-03.md', '# 2026-10-03\n');
    await settle([A, B]);
    A.write('Daily/2026-10-03.md', '# 2026-10-03\n- desktop: wrote report\n');
    B.write('Daily/2026-10-03.md', '# 2026-10-03\n- phone: bought milk\n');
    await settle([B, A]);
    eq(A.read('Daily/2026-10-03.md'), '# 2026-10-03\n- desktop: wrote report\n- phone: bought milk\n', `${t}: both lines kept, the merging device first`);
    assertConverged(world, [A, B], eq, t);
  });

  await scenario('overlapping edits keep both versions', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    A.write('plan.md', 'title\nbody\n');
    await settle([A, B]);
    B.write('plan.md', 'title\nbody from the phone\n');
    await B.sync();
    A.write('plan.md', 'title\nbody from the desktop\n');
    const report = await A.sync();
    eq(report.conflicts.length, 1, `${t}: one conflict`);
    eq(A.read('plan.md'), 'title\nbody from the desktop\n', `${t}: the device's own version keeps the name`);
    const copies = conflictCopies(A);
    eq(copies.length, 1, `${t}: one conflict copy`);
    eq(A.read(copies[0]), 'title\nbody from the phone\n', `${t}: the copy holds the other version`);
    await settle([A, B]);
    eq(conflictCopies(B).length, 1, `${t}: the copy synced to B too`);
    eq(B.read('plan.md'), 'title\nbody from the desktop\n', `${t}: B has A's version under the name`);
    assertConverged(world, [A, B], eq, t);
  });

  await scenario('binary edited on both sides', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    A.write('img.png', 'v1');
    await settle([A, B]);
    A.write('img.png', 'v2-desktop');
    B.write('img.png', 'v2-phone');
    await settle([A, B]);
    eq(conflictCopies(A).length, 1, `${t}: images are never merged`);
    assertConverged(world, [A, B], eq, t);
  });

  await scenario('a delete propagates', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    A.write('old/gone.md', 'bye\n');
    A.write('keep.md', 'stay\n');
    await settle([A, B]);
    A.del('old/gone.md');
    await settle([A, B]);
    eq(B.read('old/gone.md'), null, `${t}: deleted on B`);
    eq(B.host.trashed.map((f) => f.path), ['old/gone.md'], `${t}: moved to B's trash, not destroyed`);
    eq(B.host.exists('old'), false, `${t}: the emptied folder is removed`);
    assertConverged(world, [A, B], eq, t);
  });

  await scenario('delete on one side, edit on the other: the edit wins', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    A.write('x.md', 'v1\n');
    await settle([A, B]);
    A.del('x.md');
    B.write('x.md', 'v2 from B\n');
    await settle([B, A]);
    eq(A.read('x.md'), 'v2 from B\n', `${t}: A got the edited file back`);
    assertConverged(world, [A, B], eq, t);

    A.write('y.md', 'v1\n');
    await settle([A, B]);
    B.del('y.md');
    await B.sync();
    A.write('y.md', 'v2 from A\n');
    await settle([A, B]);
    eq(B.read('y.md'), 'v2 from A\n', `${t}: an edit after a remote delete brings the file back`);
    assertConverged(world, [A, B], eq, t);
  });

  await scenario('a missing file without a delete event waits before deleting', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    A.write('cloud.md', 'evicted?\n');
    A.write('other.md', 'keeps the vault from looking emptied\n');
    await settle([A, B]);
    A.host.remove('cloud.md'); // gone, but no delete event (e.g. evicted by iCloud)
    const first = await A.sync();
    eq(first.deletedRemote, 0, `${t}: not deleted on first sight`);
    eq(first.followUpMs, 60000, `${t}: asks to look again later`);
    A.write('cloud.md', 'evicted?\n'); // it came back
    await A.sync();
    eq(world.server.liveRows(world.vaultId).length, 2, `${t}: the server never deleted it`);
    A.host.remove('cloud.md');
    await A.sync();
    world.clock.tick(61_000);
    const later = await A.sync();
    eq(later.deletedRemote, 1, `${t}: still missing a minute later counts as deleted`);
  });

  await scenario('renames travel as renames', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    A.write('Drafts/essay.md', 'text\n');
    await settle([A, B]);
    const puts = world.server.calls.putBlob;
    A.mv('Drafts/essay.md', 'Published/essay.md');
    const reports = await settle([A, B]);
    eq(world.server.calls.putBlob, puts, `${t}: no content re-uploaded for a rename`);
    eq(reports.find((r) => r.device === 'B').renamed, 1, `${t}: B renamed instead of downloading`);
    eq(B.host.trashed.length, 0, `${t}: nothing left in B's trash`);
    eq(B.read('Published/essay.md'), 'text\n', `${t}: moved on B`);
    eq(B.host.exists('Drafts'), false, `${t}: old folder cleaned up`);
    A.mv('Published/essay.md', 'Published/Essay.md');
    await settle([A, B]);
    eq(B.read('Published/Essay.md'), 'text\n', `${t}: a case-only rename reaches a case-sensitive device`);
    assertConverged(world, [A, B], eq, t);
  });

  await scenario('a rename racing an edit loses nothing', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    A.write('note.md', 'base\n');
    await settle([A, B]);
    A.mv('note.md', 'renamed.md');
    B.write('note.md', 'base\nedited on B\n');
    await settle([A, B]);
    eq(A.read('renamed.md'), 'base\n', `${t}: the rename stands`);
    eq(A.read('note.md'), 'base\nedited on B\n', `${t}: the edit is kept under the old name`);
    assertConverged(world, [A, B], eq, t);
  });

  await scenario('offline edits on both devices reconcile', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    A.write('a.md', 'a\n');
    A.write('shared.md', '1\n2\n3\n4\n');
    await settle([A, B]);
    world.server.offline = true;
    A.write('from-a.md', 'A was offline\n');
    A.write('shared.md', '1 (A)\n2\n3\n4\n');
    B.write('from-b.md', 'B was offline\n');
    B.write('shared.md', '1\n2\n3\n4 (B)\n');
    B.del('a.md');
    const offline = await A.sync();
    eq(offline.status, 'error', `${t}: an offline sync reports an error`);
    ok(offline.error instanceof BackendError && offline.error.transient, `${t}: and it is a transient one`);
    world.server.offline = false;
    await settle([A, B]);
    eq(A.read('shared.md'), '1 (A)\n2\n3\n4 (B)\n', `${t}: offline edits merged`);
    eq(A.read('a.md'), null, `${t}: offline delete applied`);
    eq(B.read('from-a.md'), 'A was offline\n', `${t}: new files exchanged`);
    assertConverged(world, [A, B], eq, t);
  });

  await scenario('a competing commit between pull and push', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    A.write('race.md', 'l1\nl2\nl3\nl4\nl5\n');
    await settle([A, B]);
    A.write('race.md', 'l1 A\nl2\nl3\nl4\nl5\n');
    world.server.beforeCommit = async () => {
      B.write('race.md', 'l1\nl2\nl3\nl4\nl5 B\n');
      await B.sync(); // B commits first
    };
    const report = await A.sync();
    eq(report.status, 'synced', `${t}: A recovers within the same sync`);
    eq(A.read('race.md'), 'l1 A\nl2\nl3\nl4\nl5 B\n', `${t}: the compare-and-set refusal led to a merge`);
    await settle([A, B]);
    assertConverged(world, [A, B], eq, t);
  });

  await scenario('a user edit during a download is not overwritten', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    A.write('live.md', 'a\nb\nc\nd\n');
    await settle([A, B]);
    A.write('live.md', 'a\nb\nc\nd (A)\n');
    await A.sync();
    B.host.beforeWrite = (path) => {
      if (path === 'live.md') {
        B.host.beforeWrite = null;
        B.write('live.md', 'a (typing on B)\nb\nc\nd\n');
      }
    };
    await settle([B, A]);
    eq(B.read('live.md'), 'a (typing on B)\nb\nc\nd (A)\n', `${t}: the edit typed during the download was merged`);
    assertConverged(world, [A, B], eq, t);
  });

  await scenario('Persian names from a device that stores NFD', async (world, t) => {
    const mac = device(world, 'mac', { ci: true, nfd: true });
    const phone = device(world, 'phone');
    const composed = 'یادداشت‌ها/آب و هوا.md';
    mac.write(composed, 'هوا آفتابی است\n');
    eq(mac.host.list()[0].path === composed, false, `${t}: the mac really stores the decomposed form`);
    await settle([mac, phone]);
    eq((await serverPaths(world)), [composed], `${t}: the server holds the NFC name`);
    eq(phone.read(composed), 'هوا آفتابی است\n', `${t}: the phone found it under the composed name`);
    phone.write(composed, 'هوا آفتابی است\nفردا باران\n');
    await settle([mac, phone]);
    eq(mac.read(composed), 'هوا آفتابی است\nفردا باران\n', `${t}: the edit reached the decomposed file`);
    eq(mac.host.list().length, 1, `${t}: no duplicate under the other spelling`);
  });

  await scenario('a case-insensitive device meets names that differ only in case', async (world, t) => {
    const linux = device(world, 'linux');
    const iphone = device(world, 'iphone', { ci: true });
    linux.write('Note.md', 'upper\n');
    linux.write('note.md', 'lower\n');
    const reports = await settle([linux, iphone]);
    eq(iphone.host.list().length, 1, `${t}: the phone keeps one of them`);
    eq(iphone.read('Note.md'), 'upper\n', `${t}: the first committed`);
    ok(reports.some((r) => r.device === 'iphone' && r.skipped.includes('note.md')), `${t}: the other is reported`);
    eq(world.server.liveRows(world.vaultId).length, 2, `${t}: and never deleted from the server`);
  });

  await scenario('excluding a folder does not delete it anywhere', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    A.write('Private/diary.md', 'secret\n');
    A.write('Public/post.md', 'hello\n');
    await settle([A, B]);
    A.options = { ...A.options, excludedFolders: ['Private'] };
    A.write('Private/diary.md', 'secret, edited\n');
    await settle([A, B]);
    eq(B.read('Private/diary.md'), 'secret\n', `${t}: B keeps the folder, without A's later edits`);
    eq(A.read('Private/diary.md'), 'secret, edited\n', `${t}: A keeps its own`);
    eq(world.server.liveRows(world.vaultId).length, 2, `${t}: nothing deleted on the server`);
  });

  await scenario('mass deletes wait for approval', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    for (let i = 0; i < 10; i++) A.write(`f${i}.md`, `${i}\n`);
    await settle([A, B]);
    for (let i = 0; i < 6; i++) A.del(`f${i}.md`);
    A.write('new.md', 'still syncs\n');
    const held = await A.sync();
    eq(held.status, 'needs-confirmation', `${t}: 60% deleted asks first`);
    eq(held.confirmation.remote.length, 6, `${t}: lists the six files`);
    eq(world.server.liveRows(world.vaultId).length, 11, `${t}: other changes went ahead, deletions did not`);
    const kept = await A.engine.keepDeletes();
    eq(kept.status, 'synced', `${t}: keeping them syncs`);
    eq(kept.waiting, 6, `${t}: A asks for the six files back (the server only relays)`);
    await settle([B, A]);
    eq(A.read('f0.md'), '0\n', `${t}: "keep" restored the files on A, sent by B`);

    for (let i = 0; i < 6; i++) A.del(`f${i}.md`);
    await A.sync();
    const approved = await A.engine.approveDeletes();
    eq(approved.deletedRemote, 6, `${t}: approval deletes them`);
    const incoming = await B.sync();
    eq(incoming.status, 'needs-confirmation', `${t}: B asks too before trashing six files`);
    eq(incoming.confirmation.local.length, 6, `${t}: B lists its six local files`);
    const applied = await B.engine.approveDeletes();
    eq(applied.deletedLocal, 6, `${t}: B trashes them once approved`);
    await settle([A, B]);
    assertConverged(world, [A, B], eq, t);
  });

  await scenario('approving deletes found without delete events', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    for (let i = 0; i < 10; i++) A.write(`g${i}.md`, `${i}\n`);
    await settle([A, B]);
    for (let i = 0; i < 6; i++) A.host.remove(`g${i}.md`); // removed while Obsidian was closed
    const first = await A.sync();
    eq([first.status, first.deletedRemote], ['synced', 0], `${t}: first it only waits`);
    world.clock.tick(61_000);
    const held = await A.sync();
    eq(held.status, 'needs-confirmation', `${t}: a minute later it asks`);
    const approved = await A.engine.approveDeletes();
    eq(approved.deletedRemote, 6, `${t}: one approval is enough`);
    world.clock.tick(61_000);
    eq((await A.sync()).status, 'synced', `${t}: and it does not ask again`);
  });

  await scenario('an emptied local vault never wipes the server', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    A.write('a.md', 'a\n');
    A.write('b.md', 'b\n');
    await settle([A, B]);
    A.del('a.md');
    A.del('b.md');
    const report = await A.sync();
    eq(report.status, 'needs-confirmation', `${t}: an empty vault always asks`);
    await B.sync();
    eq(B.read('a.md'), 'a\n', `${t}: B untouched`);
  });

  await scenario('a wiped server is refilled, not mirrored', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    A.write('a.md', 'a\n');
    await settle([A, B]);
    world.server.wipe(world.vaultId);
    await settle([A, B]);
    eq(A.read('a.md'), 'a\n', `${t}: A kept its file`);
    eq((await serverPaths(world)), ['a.md'], `${t}: and uploaded it again`);
  });

  await scenario('a copied state file is not trusted', async (world, t) => {
    const A = device(world, 'A');
    A.write('a.md', 'a\n');
    await settle([A]);
    const C = device(world, 'C');
    C.store.saved = A.store.saved; // e.g. the plugin folder copied from A
    const report = await C.sync();
    eq(report.deletedRemote, 0, `${t}: C does not read A's files as deleted`);
    eq(report.waiting, 1, `${t}: C asks for them instead`);
    await settle([A, C]);
    eq(C.read('a.md'), 'a\n', `${t}: and receives them from A`);
  });

  await scenario('three devices', async (world, t) => {
    const A = device(world, 'A');
    const B = device(world, 'B');
    const C = device(world, 'C', { ci: true });
    A.write('shared.md', 'x\ny\nz\n');
    await settle([A, B, C]);
    A.write('shared.md', 'x A\ny\nz\n');
    C.write('shared.md', 'x\ny\nz C\n');
    B.write('b.md', 'from B\n');
    await settle([A, B, C]);
    eq(B.read('shared.md'), 'x A\ny\nz C\n', `${t}: three-way merge across devices`);
    assertConverged(world, [A, B, C], eq, t);
  });

  // ── crash at every step of a busy cycle ───────────────────────────────────
  let crashes = 0;
  for (let k = 1; k < 200; k++) {
    const world = await makeWorld({ encrypted });
    const A = device(world, 'A');
    const B = device(world, 'B');
    A.write('merge.md', '1\n2\n3\n4\n5\n');
    A.write('pic.png', 'v1');
    A.write('gone.md', 'bye\n');
    A.write('stay.md', 'stay\n');
    await settle([A, B]);
    B.write('merge.md', '1\n2\n3\n4\n5 B\n');
    B.write('pic.png', 'v2 B');
    B.write('fromB.md', 'B\n');
    await B.sync();
    A.write('merge.md', '1 A\n2\n3\n4\n5\n');
    A.write('pic.png', 'v2 A');
    A.write('fromA.md', 'A\n');
    A.del('gone.md');

    let ops = 0;
    let crashed = false;
    const step = () => {
      if (crashed) throw new CrashError('down');
      if (++ops === k) {
        crashed = true;
        A.host.crashed = true;
        A.store.frozen = true;
        throw new CrashError('crash');
      }
    };
    world.server.onCall = () => {
      try {
        step();
      } catch {
        throw new BackendError('network', 'Device crashed');
      }
    };
    const realMutate = A.host.write.bind(A.host);
    A.host.write = async (...args) => {
      step();
      return realMutate(...args);
    };
    await A.sync();
    world.server.onCall = null;
    A.host.write = realMutate;
    A.host.crashed = false;
    A.store.frozen = false;
    if (!crashed) break;
    crashes++;
    A.restart(); // a fresh engine: only what reached the state file survives
    await settle([A, B]);
    // The delete event died with the engine; the file now has to stay missing a minute.
    world.clock.tick(61_000);
    await settle([A, B]);
    const label = `${tag}crash at step ${k}`;
    eq(A.read('merge.md'), '1 A\n2\n3\n4\n5 B\n', `${label}: merge completed`);
    eq(conflictCopies(A).length, 1, `${label}: exactly one conflict copy for the image`);
    eq(A.read('gone.md'), null, `${label}: delete completed`);
    assertConverged(world, [A, B], eq, label);
  }
  ok(crashes > 10, `${tag}crash points exercised: ${crashes}`);

  if (encrypted) {
    const world = await makeWorld({ encrypted: true });
    const A = device(world, 'A');
    const B = device(world, 'B');
    A.write('secret.md', 'the launch code is hunter2\n');
    await settle([A, B]);
    const stored = [...world.server.blobs.values()].map((b) => Buffer.from(b).toString('latin1')).join('');
    eq(stored.includes('hunter2'), false, 'encrypted: the server holds no plain text');
    const index = JSON.stringify([...world.server.vaults.get(world.vaultId).files.values()]);
    eq(index.includes('secret'), false, 'encrypted: the index holds no file names');
    const plainHash = await crypto.subtle.digest('SHA-256', utf8('the launch code is hunter2\n'));
    const hex = Buffer.from(plainHash).toString('hex');
    eq(world.server.liveRows(world.vaultId)[0].hash === hex, false, 'encrypted: the blob id is not the plain SHA-256');
    eq(B.read('secret.md'), 'the launch code is hunter2\n', 'encrypted: B decrypts it');
  }
}

await suite(false);
await suite(true);
console.log(`SYNC_SIM_OK (${count()} checks)`);
