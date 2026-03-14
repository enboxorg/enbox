import { LitElement, html } from 'lit';
import { ContextConsumer } from '@lit/context';
import { SignalWatcher } from '@lit-labs/signals';
import { appContext } from '../../state/app-context.js';
import './index.css';

class AppsPage extends SignalWatcher(LitElement) {
  createRenderRoot() {
    return this;
  }

  constructor() {
    super();
    this.appStore = null;
    this.appStoreConsumer = new ContextConsumer(this, {
      context   : appContext,
      subscribe : true,
      callback  : (value) => {
        this.appStore = value;
      },
    });
  }

  get connections() {
    return this.appStore?.apps.connections.get() ?? [];
  }

  get accordionItems() {
    return this.connections.map((app) => toAccordionItem(app));
  }

  render() {
    return html`
      <div class="wa-stack wa-gap-xl dashboard page-block">
        <section class="wa-stack wa-gap-s">
          <div class="wa-flank:end">
            <h1>Apps</h1>
            <wa-button appearance="outlined" variant="brand">
              <wa-icon slot="start" name="plus" variant="solid"></wa-icon>
              Install App
            </wa-button>
          </div>

          <wa-divider style="padding-bottom: var(--spacing)"></wa-divider>

          <div class="wa-caption-m apps-connections-intro">
            Applications with active connections to your DWN identity.
          </div>
        </section>

        <x-accordion
          class="apps-connections-list"
          aria-live="polite"
          aria-label="Connected applications"
          empty-text="No app connections found."
          .items=${this.accordionItems}
        ></x-accordion>
      </div>
    `;
  }
}

if (!customElements.get('apps-page')) {
  customElements.define('apps-page', AppsPage);
}

/**
 * @param {string} url
 * @returns {string}
 */
function appOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * @param {string} url
 * @returns {string | null}
 */
function defaultFaviconUrl(url) {
  try {
    const parsed = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(parsed.hostname)}`;
  } catch {
    return null;
  }
}

/**
 * @param {string | undefined} isoDate
 * @returns {string}
 */
function formatDateTime(isoDate) {
  if (typeof isoDate !== 'string' || isoDate.trim().length === 0) {
    return 'Unknown';
  }

  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) {
    return 'Unknown';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle : 'medium',
    timeStyle : 'short',
  }).format(parsed);
}

/**
 * @param {import('../../state/app-store.js').AppConnection} app
 * @returns {Record<string, unknown>}
 */
function toAccordionItem(app) {
  return {
    id             : app.id,
    title          : app.name,
    subtitle       : `(${appOrigin(app.url)})`,
    avatarSrc      : app.iconUrl ?? defaultFaviconUrl(app.url),
    avatarFallback : app.name,
    description    : app.description ?? 'No description available.',
    meta           : [
      { label: 'Connected', value: formatDateTime(app.connectedAt) },
      { label: 'Status', value: app.status ?? 'Unknown' },
      { label: 'Last activity', value: formatDateTime(app.lastActivityAt) },
    ],
    tagsLabel : 'Scopes',
    tags      : Array.isArray(app.scopes) && app.scopes.length > 0 ? app.scopes : ['No scopes listed'],
  };
}
