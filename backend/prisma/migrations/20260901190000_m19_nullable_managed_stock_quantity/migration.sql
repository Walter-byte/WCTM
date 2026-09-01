-- WooCommerce may return manage_stock=true with stock_quantity=null when the
-- remote quantity is unset. Keep that state explicit: WooCommerce stock status
-- remains authoritative, and only a non-null numeric quantity participates in
-- the Store threshold. Unmanaged items must continue to persist no quantity.

ALTER TABLE "inventory_items"
  DROP CONSTRAINT "inventory_items_stock_state_check",
  ADD CONSTRAINT "inventory_items_stock_state_check" CHECK (
    "stock_status" IN ('instock', 'outofstock', 'onbackorder')
    AND ("manages_stock" OR "stock_quantity" IS NULL)
  );
