// The `state-size` item of the loop health issue (loop upgrade #14). Pure: it
// takes what the pump recorded (kv `state.size`, written at the end of every
// pump run by pump/prune.mjs), the size of the state asset the watchdog
// pulled, and the total size of the snapshot release, and returns one item.
//
//   green  the database is under 256 MiB, the snapshot release under 2 GB,
//          and the last prune pass did not fail
//   amber  the database (or the asset) is over 256 MiB; the snapshot release
//          is over 2 GB; the last prune pass failed or gave up an archive; a
//          pump run finished without recording a size
//   red    the database is over 768 MiB, or the snapshot release over 6 GB
//
// Why these numbers: the pump refuses to read a state that decrypts or
// decompresses to more than 1 GiB (scripts/state-asset.mjs MAX_STATE_BYTES),
// so red leaves a quarter of that as room to act; GitHub's own limit is
// 2 GiB per release asset. With pruning the database settles at a few MB plus
// about 330 bytes per run_key ever seen (the results table), so 256 MiB is
// far outside normal. The off-site backup holds at most 8 GB (OFFSITE_MAX_BYTES)
// and copies every snapshot, so the snapshots turn amber at a quarter of that
// and red at three quarters.
//
// It never throws: anything unexpected is an amber item.

const MiB = 1024 ** 2;
const GB = 1000 ** 3;

export const SIZE_THRESHOLDS = Object.freeze({
  amberBytes: 256 * MiB,
  redBytes: 768 * MiB,
  snapshotsAmberBytes: 2 * GB,
  snapshotsRedBytes: 6 * GB,
});

/** 1.2 MB, 340 KB, 12 B: decimal units, one decimal. */
export function humanBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

export function sizeCheck(input) {
  try {
    return judge(input);
  } catch (err) {
    return { id: 'state-size', status: 'amber', summary: `could not judge the state size: ${String(err?.message ?? err).slice(0, 200)}` };
  }
}

const RANK = { green: 0, amber: 1, red: 2 };

function judge({ size, lastRun = null, asset = null, snapshots = null, thresholds = SIZE_THRESHOLDS }) {
  const id = 'state-size';
  const t = thresholds;
  const notes = [];
  let status = 'green';
  const raise = (to, why) => {
    if (RANK[to] > RANK[status]) status = to;
    if (why) notes.push(why);
  };
  const snapBytes = Number(snapshots?.total_bytes);
  const snapText = Number.isFinite(snapBytes) ? `snapshots ${humanBytes(snapBytes)} in ${snapshots.count ?? '?'} files` : null;
  if (Number.isFinite(snapBytes)) {
    if (snapBytes > t.snapshotsRedBytes) raise('red', `the snapshot release holds over ${humanBytes(t.snapshotsRedBytes)}`);
    else if (snapBytes > t.snapshotsAmberBytes) raise('amber', `the snapshot release holds over ${humanBytes(t.snapshotsAmberBytes)}`);
  }
  if (!size || typeof size !== 'object') {
    if (lastRun) raise('amber', 'a pump run finished without recording the state size');
    const base = lastRun ? 'no state size recorded' : 'no pump run has recorded the state size yet';
    return { id, status, summary: [base, snapText, ...notes].filter(Boolean).join('; ') };
  }
  const bytes = Number(size.bytes);
  const assetBytes = Number(asset?.bytes ?? size.asset_bytes);
  const biggest = Math.max(Number.isFinite(bytes) ? bytes : 0, Number.isFinite(assetBytes) ? assetBytes : 0);
  if (biggest > t.redBytes) raise('red', `over ${humanBytes(t.redBytes)}: the pump refuses a state over 1 GiB; prune or restore now`);
  else if (biggest > t.amberBytes) raise('amber', `over ${humanBytes(t.amberBytes)}`);
  const p = size.prune;
  if (p?.status === 'error') raise('amber', `the last prune pass failed: ${String(p.error ?? 'unknown error').slice(0, 120)}`);
  else if (p?.status === 'abandoned') raise('amber', 'the last prune pass gave up its archive (nothing was deleted; it is staged again)');
  const rows = size.rows && typeof size.rows === 'object' ? size.rows : {};
  const main = ['attempts', 'dispatch_items', 'results', 'run_keys'].filter((k) => Number.isFinite(rows[k])).map((k) => `${k} ${rows[k]}`).join(', ');
  const parts = [
    `database ${humanBytes(bytes)}${Number.isFinite(assetBytes) && assetBytes > 0 ? ` (asset ${humanBytes(assetBytes)})` : ''}`,
    main || null,
    p ? `last prune: ${p.status}${p.deleted ? `, deleted ${p.deleted} rows` : ''}${p.staged ? `, staged ${p.staged} rows` : ''}` : null,
    snapText,
    ...notes,
  ];
  return { id, status, summary: parts.filter(Boolean).join('; '), ...(size.at ? { at: size.at } : {}) };
}
