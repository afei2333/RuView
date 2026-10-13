// Notification Center - Bell icon with event history
// Persists notifications across page views (sessionStorage)

import { i18n } from './i18n.js';

export class NotificationCenter {
  constructor() {
    this.button = null;
    this.panel = null;
    this.notifications = [];
    this.maxNotifications = 50;
    this.isOpen = false;
    this.unreadCount = 0;
    this.storageKey = 'ruview-notifications';
  }

  init() {
    this.loadFromStorage();
    this.createButton();
    this.createPanel();
    this.interceptEvents();
    this._unsubLocale = i18n.onLocaleChange(() => this.renderList());
  }

  createButton() {
    this.button = document.createElement('button');
    this.button.className = 'notif-bell';
    this.button.setAttribute('aria-label', i18n.t('notifications.title'));
    this.button.setAttribute('data-i18n-aria', 'notifications.title');
    this.button.setAttribute('title', i18n.t('notifications.title'));
    this.button.setAttribute('data-i18n-title', 'notifications.title');
    this.button.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      </svg>
      <span class="notif-badge" style="display:none">0</span>
    `;
    this.button.addEventListener('click', () => this.toggle());

    const headerInfo = document.querySelector('.header-info');
    if (headerInfo) {
      headerInfo.prepend(this.button);
    }

    this.updateBadge();
  }

  createPanel() {
    this.panel = document.createElement('div');
    this.panel.className = 'notif-panel';
    this.panel.setAttribute('role', 'region');
    this.panel.setAttribute('aria-label', i18n.t('notifications.history'));
    this.panel.setAttribute('data-i18n-aria', 'notifications.history');
    this.panel.innerHTML = `
      <div class="notif-panel-header">
        <span data-i18n="notifications.title">Notifications</span>
        <div class="notif-panel-actions">
          <button class="notif-mark-read" title="Mark all read" data-i18n-title="notifications.read" data-i18n="notifications.markRead">Mark read</button>
          <button class="notif-clear" title="Clear all" data-i18n-title="notifications.clear" data-i18n="ui.clear">Clear</button>
        </div>
      </div>
      <div class="notif-panel-body"></div>
    `;

    this.panel.querySelector('.notif-mark-read').addEventListener('click', () => {
      this.notifications.forEach(n => n.read = true);
      this.unreadCount = 0;
      this.updateBadge();
      this.renderList();
      this.saveToStorage();
    });

    this.panel.querySelector('.notif-clear').addEventListener('click', () => {
      this.notifications = [];
      this.unreadCount = 0;
      this.updateBadge();
      this.renderList();
      this.saveToStorage();
    });

    document.body.appendChild(this.panel);
    i18n.applyTranslations(this.panel);

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (this.isOpen && !this.panel.contains(e.target) && !this.button.contains(e.target)) {
        this.close();
      }
    });
  }

  interceptEvents() {
    // Listen for toast events to capture as notifications
    const origInfo = console.info;
    console.info = (...args) => {
      origInfo.apply(console, args);
      const msg = args.map(String).join(' ');
      // Only capture app-relevant messages
      if (msg.includes('[WS-') || msg.includes('Backend') || msg.includes('Service worker') ||
          msg.includes('connected') || msg.includes('initialized') || msg.includes('sensing')) {
        this.add(msg, 'info');
      }
    };

    const origWarn = console.warn;
    console.warn = (...args) => {
      origWarn.apply(console, args);
      const msg = args.map(String).join(' ');
      if (msg.includes('Backend') || msg.includes('unavailable') || msg.includes('[WS-') ||
          msg.includes('connection') || msg.includes('timeout')) {
        this.add(msg, 'warning');
      }
    };

    const origError = console.error;
    console.error = (...args) => {
      origError.apply(console, args);
      const msg = args.map(String).join(' ');
      if (msg.includes('Failed') || msg.includes(i18n.t('ui.error')) || msg.includes('error')) {
        this.add(msg, 'error');
      }
    };
  }

  add(message, type = 'info') {
    const notification = {
      id: Date.now() + Math.random(),
      message: this.truncate(message, 200),
      type,
      time: new Date().toISOString(),
      read: false
    };

    this.notifications.unshift(notification);
    if (this.notifications.length > this.maxNotifications) {
      this.notifications.pop();
    }

    this.unreadCount++;
    this.updateBadge();
    this.saveToStorage();

    if (this.isOpen) {
      this.renderList();
    }
  }

  toggle() {
    this.isOpen ? this.close() : this.open();
  }

  open() {
    this.isOpen = true;
    this.panel.classList.add('open');
    this.renderList();
  }

  close() {
    this.isOpen = false;
    this.panel.classList.remove('open');
  }

  renderList() {
    const body = this.panel.querySelector('.notif-panel-body');
    if (this.notifications.length === 0) {
      body.innerHTML = `<div class="notif-empty">${i18n.t('notifications.empty')}</div>`;
      return;
    }

    body.innerHTML = this.notifications.map(n => {
      const time = new Date(n.time);
      const ago = this.timeAgo(time);
      return `
        <div class="notif-item notif-${n.type} ${n.read ? 'read' : 'unread'}">
          <div class="notif-item-dot"></div>
          <div class="notif-item-content">
            <span class="notif-item-msg">${this.escapeHtml(n.message)}</span>
            <span class="notif-item-time">${ago}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  updateBadge() {
    const badge = this.button?.querySelector('.notif-badge');
    if (!badge) return;
    if (this.unreadCount > 0) {
      badge.textContent = this.unreadCount > 99 ? '99+' : this.unreadCount;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  timeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return date.toLocaleDateString();
  }

  truncate(str, max) {
    return str.length > max ? str.slice(0, max) + '...' : str;
  }

  escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  loadFromStorage() {
    try {
      const data = sessionStorage.getItem(this.storageKey);
      if (data) {
        const parsed = JSON.parse(data);
        this.notifications = parsed.notifications || [];
        this.unreadCount = parsed.unreadCount || 0;
      }
    } catch { /* noop */ }
  }

  saveToStorage() {
    try {
      sessionStorage.setItem(this.storageKey, JSON.stringify({
        notifications: this.notifications.slice(0, 20),
        unreadCount: this.unreadCount
      }));
    } catch { /* noop */ }
  }

  dispose() {
    this._unsubLocale?.();
    this.close();
    this.button?.remove();
    this.panel?.remove();
  }
}
