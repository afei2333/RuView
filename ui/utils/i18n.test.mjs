// Run: node --test ui/utils/i18n.test.mjs
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const storage = new Map();
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US' } });
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value)
};
const { I18n } = await import('./i18n.js');

function element(attributes = {}) {
  return {
    attributes, textContent: '', placeholder: '',
    getAttribute: key => attributes[key],
    setAttribute: (key, value) => { attributes[key] = value; }
  };
}

let elements;
let selector;
beforeEach(() => {
  storage.clear();
  navigator.language = 'en-US';
  elements = [];
  selector = { value: '' };
  globalThis.document = {
    documentElement: element(),
    querySelectorAll: query => elements.filter(el => Object.hasOwn(el.attributes, query.slice(1, -1))),
    getElementById: id => id === 'lang-selector' ? selector : null
  };
});

test('Chinese browser locales default to Simplified Chinese', () => {
  for (const language of ['zh', 'zh-CN', 'zh-Hans', 'zh-TW', 'zh-HK']) {
    navigator.language = language;
    const i18n = new I18n();
    assert.equal(i18n.locale, 'zh');
    assert.equal(i18n.t('nav.dashboard'), '仪表盘');
    i18n.applyTranslations();
    assert.equal(document.documentElement.attributes.lang, 'zh-CN');
  }
});

test('existing English and Polish detection and fallback remain available', () => {
  for (const [language, expected] of [['pl-PL', 'pl'], ['en-GB', 'en'], ['fr-FR', 'en']]) {
    navigator.language = language;
    assert.equal(new I18n().locale, expected);
  }
  const i18n = new I18n();
  i18n.setLocale('pl');
  assert.equal(i18n.t('nav.dashboard'), 'Panel');
  assert.equal(i18n.t('training.disabled', { cli: 'train-room' }),
    'In-server training is disabled on this build. Train from the CLI: train-room');
  assert.equal(i18n.t('unknown.key'), 'unknown.key');
  assert.equal(i18n.t('__proto__'), '__proto__');
});

test('saved choices override detection and survive a new instance', () => {
  navigator.language = 'zh-CN';
  const i18n = new I18n();
  i18n.setLocale('en');
  assert.equal(new I18n().locale, 'en');
  i18n.setLocale('zh');
  assert.equal(new I18n().locale, 'zh');
  assert.equal(selector.value, 'zh');
});

test('invalid saved and requested locales never become active', () => {
  navigator.language = 'zh-CN';
  for (const saved of ['unsupported', '__proto__', 'constructor']) {
    storage.set('ruview-locale', saved);
    const i18n = new I18n();
    assert.equal(i18n.locale, 'zh');
    i18n.setLocale(saved);
    assert.equal(i18n.locale, 'zh');
    assert.equal(storage.get('ruview-locale'), saved);
  }
});

test('blocked browser storage still permits language detection and switching', () => {
  const savedStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  try {
    navigator.language = 'zh-CN';
    const i18n = new I18n();
    assert.equal(i18n.locale, 'zh');
    i18n.setLocale('en');
    assert.equal(i18n.locale, 'en');
  } finally { globalThis.localStorage = savedStorage; }
});

test('switching updates content and accessibility attributes without changing input values', () => {
  const label = element({ 'data-i18n': 'nav.training' });
  const input = element({ 'data-i18n-placeholder': 'ui.pasteToken' });
  input.value = 'unsaved input';
  const control = element({ 'data-i18n-aria': 'misc.language', 'data-i18n-title': 'ui.quickSettings' });
  const image = element({ 'data-i18n-alt': 'ui.wifiDensePoseArchitecture' });
  elements = [label, input, control, image];
  const i18n = new I18n();
  i18n.setLocale('zh');
  assert.equal(label.textContent, '训练');
  assert.equal(input.placeholder, '粘贴令牌...');
  assert.equal(input.value, 'unsaved input');
  assert.equal(control.attributes['aria-label'], '语言');
  assert.equal(control.attributes.title, '快捷设置');
  assert.equal(image.attributes.alt, 'WiFi DensePose 架构图');
  i18n.setLocale('en');
  assert.equal(label.textContent, 'Training');
  assert.equal(input.value, 'unsaved input');
});

test('late-mounted panels can translate their own content', () => {
  const label = element({ 'data-i18n': 'ui.liveWiFiSensing' });
  const i18n = new I18n();
  i18n.setLocale('zh');
  i18n.applyTranslations({ querySelectorAll: query => query === '[data-i18n]' ? [label] : [] });
  assert.equal(label.textContent, '实时 WiFi 感知');
});

test('Observatory scenario groups translate their labels without replacing options', () => {
  const group = element({ 'data-i18n-label': 'obs.coreSensing' });
  group.options = [{ value: 'single_breathing' }];
  elements = [group];
  const i18n = new I18n();
  i18n.setLocale('zh');
  assert.equal(group.attributes.label, '基础感知');
  assert.deepEqual(group.options, [{ value: 'single_breathing' }]);
  i18n.setLocale('en');
  assert.equal(group.attributes.label, 'Core Sensing');
});

test('Observatory dynamic HUD switches immediately and preserves sensing state', async () => {
  const { i18n } = await import('./i18n.js');
  const { HudController } = await import('../observatory/js/hud-controller.js');
  i18n.dispose();
  const nodes = new Map();
  for (const id of ['presence-indicator', 'presence-label', 'fall-alert', 'scenario-description',
    'edge-modules-bar', 'data-source-label', 'fps-counter', 'hr-value', 'persons-value']) {
    nodes.set(id, { textContent: '', innerHTML: '', style: {}, classList: { add() {} } });
  }
  const dot = {};
  document.getElementById = id => nodes.get(id) ?? null;
  document.querySelector = () => dot;
  globalThis.WebSocket = { OPEN: 1 };
  const obs = { settings: { dataSource: 'ws', scenario: 'fall_event', bloom: 0.08 },
    _ws: { readyState: 1 }, _fpsValue: 59 };
  const hud = new HudController(obs);
  const data = { vital_signs: { heart_rate_bpm: 72 }, estimated_persons: 1,
    classification: { presence: true, motion_level: 'active', fall_detected: true, confidence: 0.9 } };
  const demo = { _autoMode: false, currentScenario: 'fall_event', paused: true };
  i18n.setLocale('en');
  hud.updateHUD(data, demo);
  assert.equal(nodes.get('presence-label').textContent, 'ACTIVE');
  const heartRate = nodes.get('hr-value').textContent;
  const lerpHr = hud._lerpHr;
  const settings = structuredClone(obs.settings);
  i18n.setLocale('zh');
  assert.equal(nodes.get('data-source-label').textContent, '实时');
  assert.equal(dot.className, 'dot dot--live');
  assert.equal(nodes.get('presence-label').textContent, '活跃');
  assert.match(nodes.get('scenario-description').textContent, /姿态变化/);
  assert.match(nodes.get('edge-modules-bar').innerHTML, /跌倒/);
  assert.equal(nodes.get('fps-counter').textContent, '59 帧/秒');
  assert.equal(nodes.get('fall-alert').style.display, 'block');
  assert.equal(nodes.get('hr-value').textContent, heartRate);
  assert.equal(hud._lerpHr, lerpHr);
  assert.deepEqual(obs.settings, settings);
  assert.equal(demo.paused, true);
  i18n.setLocale('en');
  assert.match(nodes.get('scenario-description').textContent, /Sudden posture-change/);
  assert.match(nodes.get('edge-modules-bar').innerHTML, />FALL</);
  assert.equal(nodes.get('presence-label').textContent, 'ACTIVE');
  assert.equal(nodes.get('data-source-label').textContent, 'LIVE');
  for (const [cls, expected] of [[{ presence: true }, '有人'], [{ presence: false }, '无人']]) {
    hud.updateHUD({ classification: cls }, demo);
    i18n.setLocale('zh');
    assert.equal(nodes.get('presence-label').textContent, expected);
    i18n.setLocale('en');
  }
  hud.updateSourceBadge('demo', null);
  assert.equal(nodes.get('data-source-label').textContent, 'DEMO');
  i18n.dispose();
  delete globalThis.WebSocket;
});

test('every Observatory scenario description and module has an English and Chinese message', async () => {
  const { i18n } = await import('./i18n.js');
  const { HudController } = await import('../observatory/js/hud-controller.js');
  const description = { textContent: '' };
  const badges = { innerHTML: '', style: {} };
  document.getElementById = id => id === 'scenario-description' ? description
    : id === 'edge-modules-bar' ? badges : null;
  const hud = new HudController({});
  const page = readFileSync(new URL('../observatory.html', import.meta.url), 'utf8');
  const scenarios = new Set(Array.from(page.matchAll(/<option value="([^"]+)" data-i18n="obs\.(?:autoCycle|emptyRoom|vitalSigns|multiPerson|fallDetect|sleepMonitor|intrusion|gestureCtrl|crowd4|searchRescue|elderlyCare|fitness|securityPatrol)"/g), match => match[1]));
  assert.equal(scenarios.size, 13);
  for (const locale of ['en', 'zh']) {
    i18n.setLocale(locale);
    for (const scenario of scenarios) {
      hud._updateScenarioDescription(scenario);
      hud._updateEdgeModules(scenario);
      assert.ok(description.textContent.length > 0);
      assert.doesNotMatch(description.textContent + badges.innerHTML, /obs\./);
      if (locale === 'zh') assert.match(description.textContent, /[\u4e00-\u9fff]/);
    }
  }
  i18n.dispose();
});

test('dynamic statuses and parameters preserve data provenance and unknown server values', () => {
  const i18n = new I18n();
  i18n.setLocale('zh');
  assert.equal(i18n.status('present_still'), '有人静止');
  assert.equal(i18n.status('healthy'), '正常');
  assert.equal(i18n.status('future_state'), 'FUTURE_STATE');
  assert.equal(i18n.t('training.epoch', { epoch: 3, total: 10 }), '训练轮次 3/10');
  assert.equal(i18n.t('error.start', { message: '$& {epoch}' }), '启动失败：$& {epoch}');
  assert.match(i18n.t('ui.inventedDATANOTMEASUREDStatus'), /非实测/);
});

test('locale listeners fire after translation and can unsubscribe', () => {
  const label = element({ 'data-i18n': 'nav.dashboard' });
  elements = [label];
  const i18n = new I18n();
  let calls = 0;
  const unsubscribe = i18n.onLocaleChange(locale => {
    calls++;
    assert.equal(locale, 'zh');
    assert.equal(label.textContent, '仪表盘');
  });
  i18n.setLocale('zh');
  unsubscribe();
  i18n.setLocale('en');
  assert.equal(calls, 1);
});

test('all translation keys used by the dashboard shell and its modules have Chinese entries', () => {
  const i18n = new I18n();
  i18n.setLocale('zh');
  const files = [new URL('../index.html', import.meta.url), new URL('../observatory.html', import.meta.url)];
  for (const folder of ['../components/', '../observatory/js/', './']) {
    const directory = new URL(folder, import.meta.url);
    for (const file of readdirSync(directory)) {
      if (file.endsWith('.js') && file !== 'i18n.js') files.push(new URL(file, directory));
    }
  }
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/data-i18n(?:-(?:aria|placeholder|title|alt|label))?="([^"$]+)"|i18n\.t\(['"]([^'"]+)['"]/g)) {
      const key = match[1] || match[2];
      assert.notEqual(i18n.t(key), key, `${file.pathname}: missing translation ${key}`);
    }
  }
  assert.deepEqual(i18n.getAvailableLocales(), ['en', 'pl', 'zh']);
});

test('Chinese matches every English key and dictionaries contain no duplicate keys', () => {
  const source = readFileSync(new URL('./i18n.js', import.meta.url), 'utf8');
  const sections = source.split(/^  (en|pl|zh): \{\n/m);
  const keys = {};
  for (let index = 1; index < sections.length; index += 2) {
    const entries = Array.from(sections[index + 1].split('\n};')[0]
      .matchAll(/^    ['"]([^'"]+)['"]:/gm), match => match[1]);
    assert.equal(new Set(entries).size, entries.length, `duplicate key in ${sections[index]}`);
    keys[sections[index]] = entries.sort();
  }
  assert.deepEqual(keys.zh, keys.en);
});
