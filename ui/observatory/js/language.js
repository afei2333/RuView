import { i18n } from '../../utils/i18n.js';

// Initialize independently of Three.js so language controls do not depend on the CDN.
i18n.applyTranslations();
const selector = document.getElementById('lang-selector');
selector.addEventListener('change', () => i18n.setLocale(selector.value));
