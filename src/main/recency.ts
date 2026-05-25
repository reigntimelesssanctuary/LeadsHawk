/**
 * v1.8 — per-brand / per-product scan recency.
 *
 * Different brands have wildly different lead times from buying signal to
 * vendor selection. A breach is "act today"; a corporate office relocation
 * is "engage anytime in the next 6-18 months". Forcing every scan onto a
 * single global recency window is wrong for at least one brand in every
 * mixed portfolio.
 *
 * Resolution order (most specific wins):
 *   1. product.scan_recency_override   — explicit user choice on the product
 *   2. product.scan_recency_auto       — set by product research
 *   3. brand.scan_recency_override     — explicit user choice on the brand
 *   4. brand.scan_recency_auto         — set by brand research
 *   5. settings.scanRecency            — global default
 */

import { getSettings } from './settings.js';
import type { Brand, Product, Settings } from '@shared/types';

export type Recency = 'day' | 'week' | 'month' | 'year';
const VALID: ReadonlySet<Recency> = new Set(['day', 'week', 'month', 'year']);

function clean(v: string | null | undefined): Recency | null {
  if (!v) return null;
  return VALID.has(v as Recency) ? (v as Recency) : null;
}

export type RecencyResolution = {
  value: Recency;
  source: 'product_override' | 'product_auto' | 'brand_override' | 'brand_auto' | 'global';
};

export function resolveScanRecency(product: Product, brand: Brand, settings?: Settings): RecencyResolution {
  const s = settings ?? getSettings();
  const candidates: Array<{ v: Recency | null; source: RecencyResolution['source'] }> = [
    { v: clean(product.scan_recency_override), source: 'product_override' },
    { v: clean(product.scan_recency_auto),     source: 'product_auto' },
    { v: clean(brand.scan_recency_override),   source: 'brand_override' },
    { v: clean(brand.scan_recency_auto),       source: 'brand_auto' },
    { v: clean(s.scanRecency),                  source: 'global' }
  ];
  for (const c of candidates) {
    if (c.v) return { value: c.v, source: c.source };
  }
  return { value: 'week', source: 'global' };
}

export function recencyHumanLabel(r: Recency): string {
  switch (r) {
    case 'day':   return 'Last 24 hours';
    case 'week':  return 'Last 7 days';
    case 'month': return 'Last 30 days';
    case 'year':  return 'Last 12 months';
  }
}
