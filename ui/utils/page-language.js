import { i18n } from './i18n.js';

// Keep language switching available even if a rendering dependency fails.
i18n.applyTranslations();
const selector = document.getElementById('lang-selector');
selector.addEventListener('change', () => i18n.setLocale(selector.value));
