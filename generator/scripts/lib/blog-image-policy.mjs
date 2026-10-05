/**
 * Shared policy for article hero images.
 *
 * Keep the target below the 200 KiB threshold used by the public SEO audit
 * while preserving the 1200×675 minimum required by News/Discover surfaces.
 * The quality ladder is intentionally shared by every image-producing path so
 * journalist uploads cannot drift away from generated articles.
 */
export const BLOG_IMAGE_TARGET_MAX_BYTES = 190 * 1024;
export const BLOG_IMAGE_HARD_MAX_BYTES = 320 * 1024;
export const BLOG_IMAGE_WIDTH = 1200;
export const BLOG_IMAGE_HEIGHT = 675;

/**
 * Start with the normal quality and step down only when the byte target needs
 * it. No generated image is needlessly re-encoded at a lower quality.
 */
export const BLOG_IMAGE_QUALITY_PASSES = Object.freeze([
  75, 70, 65, 60, 55, 50, 45, 40, 35, 30, 25, 20,
]);
