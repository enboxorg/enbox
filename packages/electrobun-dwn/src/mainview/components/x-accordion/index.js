import { LitElement, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { adoptComponentStyle } from '../style-registry.js';
import '../hash-avatar/index.js';

/**
 * @typedef XAccordionMetaItem
 * @property {string} label
 * @property {string} value
 */

/**
 * @typedef XAccordionItem
 * @property {string} id
 * @property {string} title
 * @property {string=} subtitle
 * @property {string=} avatarSrc
 * @property {string=} avatarHash
 * @property {string=} avatarFallback
 * @property {string=} description
 * @property {XAccordionMetaItem[]=} meta
 * @property {string[]=} tags
 * @property {string=} tagsLabel
 * @property {boolean=} open
 * @property {string=} summaryLeadingHtml
 * @property {string=} summaryTrailingHtml
 * @property {string=} panelHtml
 */

const accordionStylesheetUrl = new URL(
  import.meta.url.includes('/components/x-accordion/')
    ? './index.css'
    : './components/x-accordion/index.css',
  import.meta.url,
);

void adoptComponentStyle('x-accordion', accordionStylesheetUrl).catch((error) => {
  console.error('Failed to adopt x-accordion styles', error);
});

class XAccordion extends LitElement {
  static properties = {
    items: { attribute: false },
    emptyText: { attribute: 'empty-text' },
    ariaLabel: { attribute: 'aria-label' },
  };

  createRenderRoot() {
    return this;
  }

  constructor() {
    super();
    /** @type {XAccordionItem[]} */
    this.items = [];
    this.emptyText = 'No items found.';
    this.ariaLabel = 'Accordion list';
  }

  /**
   * @param {Event} event
   */
  onAvatarError(event) {
    const image = event.currentTarget;
    if (!(image instanceof HTMLImageElement)) {
      return;
    }

    image.hidden = true;
    const fallback = image.nextElementSibling;
    if (fallback instanceof HTMLElement) {
      fallback.hidden = false;
    }
  }

  /**
   * @param {XAccordionItem} item
   * @returns {string}
   */
  avatarFallback(item) {
    const explicitFallback = typeof item.avatarFallback === 'string' ? item.avatarFallback.trim() : '';
    if (explicitFallback.length > 0) {
      return explicitFallback.slice(0, 2).toUpperCase();
    }

    return item.title.trim().slice(0, 1).toUpperCase();
  }

  /**
   * @param {XAccordionItem} item
   * @returns {import('lit-html').TemplateResult}
   */
  renderItem(item) {
    const meta = Array.isArray(item.meta) ? item.meta : [];
    const tags = Array.isArray(item.tags) ? item.tags : [];
    const fallback = this.avatarFallback(item);
    const avatarHash = typeof item.avatarHash === 'string' ? item.avatarHash.trim() : '';
    const hasSummaryLeading = typeof item.summaryLeadingHtml === 'string'
      && item.summaryLeadingHtml.trim().length > 0;
    const hasSummaryTrailing = typeof item.summaryTrailingHtml === 'string'
      && item.summaryTrailingHtml.trim().length > 0;

    return html`
      <wa-details class="item" data-item-id=${item.id} ?open=${item.open === true}>
        <div slot="summary" class="summary">
          ${hasSummaryLeading
            ? html`<div class="summary-leading">${unsafeHTML(item.summaryLeadingHtml)}</div>`
            : nothing}
          <div class="main">
            <span class="avatar" aria-hidden="true">
              ${avatarHash
                ? html`
                    <hash-avatar
                      hash=${avatarHash}
                      initials=${fallback}
                      label=${`${item.title} avatar`}
                    ></hash-avatar>
                  `
                : item.avatarSrc
                ? html`
                    <img
                      class="avatar-image"
                      src=${item.avatarSrc}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      @error=${this.onAvatarError}
                    >
                    <span class="avatar-fallback" hidden>${fallback}</span>
                  `
                : html`<span class="avatar-fallback">${fallback}</span>`}
            </span>

            <div class="summary-text">
              <span class="title">${item.title}</span>
              ${item.subtitle ? html`<span class="subtitle">${item.subtitle}</span>` : nothing}
            </div>
          </div>
          ${hasSummaryTrailing
            ? html`<div class="summary-trailing">${unsafeHTML(item.summaryTrailingHtml)}</div>`
            : nothing}
        </div>

        <div class="panel">
          ${item.description ? html`<p class="description">${item.description}</p>` : nothing}

          ${meta.length > 0
            ? html`
                <dl class="meta">
                  ${meta.map((entry) => html`<dt>${entry.label}</dt><dd>${entry.value}</dd>`)}
                </dl>
              `
            : nothing}

          ${tags.length > 0
            ? html`
                <div class="tags">
                  <div class="tags-label">${item.tagsLabel || 'Details'}</div>
                  <div class="tags-list">
                    ${tags.map((tag) => html`<span class="tag">${tag}</span>`)}
                  </div>
                </div>
              `
            : nothing}

          ${typeof item.panelHtml === 'string' && item.panelHtml.trim().length > 0
            ? html`<div class="panel-html">${unsafeHTML(item.panelHtml)}</div>`
            : nothing}
        </div>
      </wa-details>
    `;
  }

  render() {
    if (!Array.isArray(this.items) || this.items.length === 0) {
      return html`
        <wa-callout appearance="accent">
          ${this.emptyText}
        </wa-callout>
      `;
    }

    return html`
      <div class="list" role="list" aria-label=${this.ariaLabel}>
        ${repeat(
          this.items,
          (item) => item.id,
          (item) => this.renderItem(item),
        )}
      </div>
    `;
  }
}

if (!customElements.get('x-accordion')) {
  customElements.define('x-accordion', XAccordion);
}
