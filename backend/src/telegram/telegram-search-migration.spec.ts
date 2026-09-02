import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('M20 search/report migration', () => {
  const sql = readFileSync(
    join(
      process.cwd(),
      'prisma/migrations/20260903120000_m20_search_daily_report/migration.sql'
    ),
    'utf8'
  );

  it('adds bounded encrypted search references and only projection indexes', () => {
    expect(sql).toContain('telegram_search_references_shape_check');
    expect(sql).toContain('"query_encrypted" TEXT');
    expect(sql).toContain('"page_offset" BETWEEN 0 AND 192');
    expect(sql).toContain('orders_store_created_status_active_idx');
    expect(sql).toContain('orders_store_customer_display_search_idx');
    expect(sql).toContain('inventory_store_sku_search_idx');
    expect(sql).toContain('inventory_store_display_name_search_idx');
    expect(sql).not.toMatch(
      /CREATE (?:TABLE|MATERIALIZED VIEW) "(?:customers|products|reports|search_documents)/i
    );
    expect(sql).not.toContain('pg_trgm');
  });
});
