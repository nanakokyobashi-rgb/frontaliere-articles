/**
 * Slug per locale degli articoli della sezione canton-basilea (Basilea).
 * Scritto da generator/scripts/create-article.mjs --section=canton-basilea.
 */
export const CANTON_SLUGS: Record<string, { it: string; en: string; de: string; fr: string }> = {
 'permessi-edilizi-digitali-basel': { it: 'permessi-edilizi-digitali-basel', en: 'basel-digital-building-permits-2027', de: 'basel-baugesuche-ab-2027-digital', fr: 'bale-demandes-permis-numeriques-2027' },
 'detrazioni-figli-basel': { it: 'detrazioni-figli-basel', en: 'basel-child-tax-deductions', de: 'basel-kinderabzuege-steuern', fr: 'bale-deductions-enfants' },
 'phishing-email-fisco-basel': { it: 'phishing-email-fisco-basel', en: 'basel-fake-tax-emails', de: 'basel-betruegerische-steuer-emails', fr: 'bale-e-mails-fiscaux-frauduleux' },
};

export const CANTON_SLUG_FALLBACK_REASONS: Record<string, Record<string, string>> = {
};

export const ALL_CANTON_ARTICLE_IDS: string[] = Object.keys(CANTON_SLUGS);
