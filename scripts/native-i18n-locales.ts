/**
 * Shared native-app locale list. Lives outside native-app-i18n.ts so the
 * derived generators (android-app-i18n, apple-app-i18n) can import it without
 * creating a cycle with native-app-i18n's top-level CLI await, which chains
 * those generators after rewriting the inventory.
 */
// English-only fork: OpenCrustacean ships English strings only, so this list
// is intentionally empty. See RENAME-CHECKLIST.md for the rationale.
export const NATIVE_I18N_LOCALES = [] as const;
