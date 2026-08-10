import { describe, expect, it } from 'vitest';

import { depositInInbox, type InboxFileSystem } from './inbox';

type Operation =
  | { op: 'ensureDir'; path: string }
  | { op: 'writeFile'; path: string; bytes: number }
  | { op: 'rename'; from: string; to: string }
  | { op: 'remove'; path: string };

function fakeFs(options: { renameFails?: boolean } = {}): {
  fs: InboxFileSystem;
  operations: Operation[];
} {
  const operations: Operation[] = [];
  const fs: InboxFileSystem = {
    ensureDir: async (path) => {
      operations.push({ op: 'ensureDir', path });
    },
    writeFile: async (path, data) => {
      operations.push({ op: 'writeFile', path, bytes: data.byteLength });
    },
    rename: async (from, to) => {
      operations.push({ op: 'rename', from, to });
      if (options.renameFails === true) throw new Error('EXDEV');
    },
    remove: async (path) => {
      operations.push({ op: 'remove', path });
    },
  };
  return { fs, operations };
}

const DATA = new Uint8Array([1, 2, 3, 4]);

describe('depositInInbox', () => {
  it('écrit sous .part puis renomme — le watcher ne voit jamais un .fit partiel', async () => {
    const { fs, operations } = fakeFs();

    await depositInInbox({
      inboxDir: '/data/fit-inbox',
      fileName: 'intervals-i900.fit',
      data: DATA,
      fs,
    });

    expect(operations).toEqual([
      { op: 'ensureDir', path: '/data/fit-inbox' },
      { op: 'writeFile', path: '/data/fit-inbox/intervals-i900.fit.part', bytes: 4 },
      {
        op: 'rename',
        from: '/data/fit-inbox/intervals-i900.fit.part',
        to: '/data/fit-inbox/intervals-i900.fit',
      },
    ]);
  });

  it('nettoie le temporaire et propage quand le renommage échoue', async () => {
    const { fs, operations } = fakeFs({ renameFails: true });

    await expect(
      depositInInbox({
        inboxDir: '/data/fit-inbox',
        fileName: 'intervals-i901.fit',
        data: DATA,
        fs,
      }),
    ).rejects.toThrow('EXDEV');

    expect(operations.at(-1)).toEqual({
      op: 'remove',
      path: '/data/fit-inbox/intervals-i901.fit.part',
    });
  });
});
