/**
 * Static AdSense units requested by the mirrored canton-section engine.
 *
 * The engine receives semantic placement names through SiteShellContract;
 * this host owns the publisher id and the live unit configuration. Keep the
 * markup aligned with `build-plugins/lib/adSlotHtml.ts` in the site repo so a
 * corpus-rendered page and a full site build reserve the same space.
 */
import { ADSENSE_CLIENT_ID } from './constants';

/**
 * Kept host-local so this half can land one commit before the mirrored engine
 * during a rolling contract update. The engine declares the same semantic
 * union once its mirror PR lands.
 */
export type StaticAdSlotKey =
  | 'canton-hub-top'
  | 'canton-hub-inline-1'
  | 'canton-hub-inline-2'
  | 'canton-hub-end'
  | 'article-atf';

export interface StaticAdSlotHtmlOptions {
  collapseWhenUnfilled?: boolean;
  placement?: string;
  experimentId?: string;
  experimentVariant?: string;
}

const STATIC_AD_SLOTS: Record<StaticAdSlotKey, {
  slot: string;
  format: string;
  layout?: string;
  placeholderMinHeight: number;
  placement?: string;
  fullWidthResponsive: boolean;
}> = {
  'canton-hub-top': {
    slot: '3205029282',
    format: 'horizontal',
    placeholderMinHeight: 100,
    fullWidthResponsive: true,
  },
  'canton-hub-inline-1': {
    slot: '1982411173',
    format: 'fluid',
    layout: 'in-article',
    placeholderMinHeight: 220,
    fullWidthResponsive: false,
  },
  'canton-hub-inline-2': {
    slot: '6483829128',
    format: 'fluid',
    layout: 'in-article',
    placeholderMinHeight: 220,
    fullWidthResponsive: false,
  },
  'canton-hub-end': {
    slot: '5196931137',
    format: 'autorelaxed',
    placeholderMinHeight: 400,
    placement: 'ssg_end_multiplex',
    fullWidthResponsive: false,
  },
  'article-atf': {
    slot: '1982411173',
    format: 'fluid',
    layout: 'in-article',
    placeholderMinHeight: 220,
    placement: 'article-atf',
    fullWidthResponsive: false,
  },
};

export function isStaticAdSlotKey(value: unknown): value is StaticAdSlotKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(STATIC_AD_SLOTS, value);
}

function safeDataValue(value: string): string {
  return String(value).replace(/[^a-zA-Z0-9_.:-]/g, '-').slice(0, 80);
}

export function staticAdSlotHtml(slot: StaticAdSlotKey, options?: StaticAdSlotHtmlOptions): string {
  if (!isStaticAdSlotKey(slot)) return '';

  const config = STATIC_AD_SLOTS[slot];
  const attrs = [
    'class="adsbygoogle"',
    `style="display:block;min-height:${config.placeholderMinHeight}px"`,
    `data-ad-client="${ADSENSE_CLIENT_ID}"`,
    `data-ad-slot="${config.slot}"`,
    `data-ad-format="${config.format}"`,
  ];
  if (config.layout) attrs.push(`data-ad-layout="${config.layout}"`);
  if (options?.placement || config.placement) {
    attrs.push(`data-ad-placement="${safeDataValue(options?.placement || config.placement || '')}"`);
  }
  if (options?.collapseWhenUnfilled) attrs.push('data-ft-static-ad="true"');
  if (options?.experimentId) attrs.push(`data-ad-experiment="${safeDataValue(options.experimentId)}"`);
  if (options?.experimentVariant) attrs.push(`data-ad-variant="${safeDataValue(options.experimentVariant)}"`);
  if (config.fullWidthResponsive) attrs.push('data-full-width-responsive="true"');
  return `<ins ${attrs.join(' ')}></ins>`;
}
