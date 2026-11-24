-- Schema version 4: multi-item shards.
--
-- A dispatch carries a list of items. The worker uploads one result bundle per
-- item, named by the item's 0-based position in that list
-- (result-<attempt_id>-<index>.tar.age), and ingest judges each item on its
-- own. item_index keeps that position. Items stored before this version are
-- numbered in the order they were inserted, which is the order they were sent.
ALTER TABLE dispatch_items ADD COLUMN item_index INTEGER NOT NULL DEFAULT 0 CHECK (item_index >= 0);
UPDATE dispatch_items SET item_index = (
  SELECT COUNT(*) FROM dispatch_items o
  WHERE o.attempt_id = dispatch_items.attempt_id AND o.rowid < dispatch_items.rowid
);
CREATE UNIQUE INDEX dispatch_items_position ON dispatch_items (attempt_id, item_index);
