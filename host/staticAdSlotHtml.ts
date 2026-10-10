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
export type StaticAdSlotKey = 'canton-hub-top' | 'canton-hub-end';

const STATIC_AD_SLOTS: Record<StaticAdSlotKey, {
  slot: string;
  format: string;
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
  'canton-hub-end': {
    slot: '5196931137',
    format: 'autorelaxed',
    placeholderMinHeight: 400,
    placement: 'ssg_end_multiplex',
    fullWidthResponsive: false,
  },
};

export function staticAdSlotHtml(slot: StaticAdSlotKey): string {
  const config = STATIC_AD_SLOTS[slot];
  const attrs = [
    'class="adsbygoogle"',
    `style="display:block;min-height:${config.placeholderMinHeight}px"`,
    `data-ad-client="${ADSENSE_CLIENT_ID}"`,
    `data-ad-slot="${config.slot}"`,
    `data-ad-format="${config.format}"`,
  ];
  if (config.placement) attrs.push(`data-ad-placement="${config.placement}"`);
  if (config.fullWidthResponsive) attrs.push('data-full-width-responsive="true"');
  return `<ins ${attrs.join(' ')}></ins>`;
}
