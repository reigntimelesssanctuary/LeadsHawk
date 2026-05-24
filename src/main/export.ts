import ExcelJS from 'exceljs';
import { getDb } from './db.js';
import type { Brand, Product, Opportunity } from '@shared/types';

/**
 * Build an in-memory .xlsx workbook of the chosen opportunities, with the
 * columns the user can act on directly (no internal ids / timestamps).
 *
 * The caller saves the resulting Buffer to disk via dialog.showSaveDialog.
 */
export async function exportOpportunitiesXlsx(ids: number[]): Promise<Buffer> {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('No opportunities selected for export.');
  }
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM opportunities WHERE id IN (${placeholders}) ORDER BY datetime(created_at) DESC, id DESC`
    )
    .all(...ids) as Opportunity[];

  const brands = db.prepare('SELECT * FROM brands').all() as Brand[];
  const products = db.prepare('SELECT * FROM products').all() as Product[];
  const brandMap = new Map(brands.map((b) => [b.id, b]));
  const productMap = new Map(products.map((p) => [p.id, p]));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'LeadsHawk';
  wb.created = new Date();
  const sheet = wb.addWorksheet('Opportunities');

  sheet.columns = [
    { header: 'Date',            key: 'date',       width: 12 },
    { header: 'Company',         key: 'company',    width: 28 },
    { header: 'Industry',        key: 'industry',   width: 22 },
    { header: 'Country',         key: 'country',    width: 18 },
    { header: 'Brand',           key: 'brand',      width: 18 },
    { header: 'Product',         key: 'product',    width: 22 },
    { header: 'Confidence',      key: 'confidence', width: 12 },
    { header: 'Signal summary',  key: 'signal',     width: 60 },
    { header: 'Background',      key: 'background', width: 70 },
    { header: 'Justified use case', key: 'use_case', width: 60 },
    { header: 'Recommended sales angle', key: 'angle', width: 60 },
    { header: 'Source title',    key: 'source_title', width: 40 },
    { header: 'Source URL',      key: 'source_url', width: 50 },
    { header: 'Source published',key: 'source_pub', width: 14 }
  ];

  for (const o of rows) {
    sheet.addRow({
      date: (o.created_at || '').slice(0, 10),
      company: o.company,
      industry: o.industry || '',
      country: o.country || '',
      brand: o.brand_id ? brandMap.get(o.brand_id)?.name || '' : '',
      product: o.product_id ? productMap.get(o.product_id)?.name || '' : '',
      confidence: o.confidence,
      signal: o.signal_summary || '',
      background: o.background || '',
      use_case: o.use_case || '',
      angle: o.angle || '',
      source_title: o.source_title || '',
      source_url: o.source_url || '',
      source_pub: (o.source_published_at || '').slice(0, 10)
    });
  }

  // Header styling
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6C5CF2' } };
  header.alignment = { vertical: 'middle', horizontal: 'left' };
  header.height = 22;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  // Confidence as percentage
  sheet.getColumn('confidence').numFmt = '0%';
  // Wrap text on the long-form columns so nothing gets clipped to one line
  for (const key of ['signal', 'background', 'use_case', 'angle']) {
    sheet.getColumn(key).alignment = { vertical: 'top', wrapText: true };
  }
  // Make source URL a real hyperlink in each row
  const urlCol = sheet.getColumn('source_url');
  urlCol.eachCell((cell, rowNumber) => {
    if (rowNumber === 1) return;
    const v = String(cell.value || '');
    if (v) {
      cell.value = { text: v, hyperlink: v };
      cell.font = { color: { argb: 'FF1D4ED8' }, underline: true };
    }
  });

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
