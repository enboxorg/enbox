import { LitElement, css, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import '../hash-avatar/index.js';
import { requestWebAwesomeDiscovery } from '../../utils/webawesome-loader.js';

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

class XAccordion extends LitElement {
  static properties = {
    items: { attribute: false },
    emptyText: { attribute: 'empty-text' },
    ariaLabel: { attribute: 'aria-label' },
  };

  static styles = css`
    :host {
      display: block;
    }

    .list {
      display: grid;
      gap: var(--wa-space-s);
    }

    .item {
      --spacing: 0;
      border: var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border);
      border-radius: var(--wa-border-radius-l);
      overflow: hidden;
      background: var(--wa-color-surface-raised);
      box-shadow: var(--panel-shadow, 0 16px 40px rgba(0, 0, 0, 0.36));
    }

    .item::part(base) {
      border: 0;
      border-radius: inherit;
      background: transparent;
    }

    .item::part(summary) {
      padding: 0;
      list-style: none;
      flex: 1;
      min-width: 0;
      overflow: hidden;
    }

    .item::part(content) {
      padding: 0;
    }

    .item::part(header) {
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--wa-space-m);
      min-width: 0;
    }

    .item::part(icon) {
      display: inline-flex;
      flex: 0 0 auto;
      margin-inline-end: var(--wa-space-l);
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-s);
    }

    .summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--wa-space-m);
      padding: var(--wa-space-m) 0 var(--wa-space-m) var(--wa-space-l);
      min-width: 0;
    }

    .main {
      display: flex;
      align-items: center;
      gap: var(--wa-space-s);
      min-width: 0;
      flex: 1 1 auto;
    }

    .avatar {
      inline-size: 2.25rem;
      block-size: 2.25rem;
      border-radius: 999px;
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      overflow: hidden;
      border: var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border);
      background: color-mix(in oklab, var(--wa-color-surface-lowered), #ffffff 10%);
    }

    .avatar-image {
      inline-size: 100%;
      block-size: 100%;
      object-fit: cover;
    }

    .avatar hash-avatar {
      inline-size: 100%;
      block-size: 100%;
    }

    .avatar-fallback {
      font-size: 0.84rem;
      font-weight: 700;
      color: var(--wa-color-text-normal);
    }

    .summary-text {
      min-width: 0;
      display: flex;
      flex: 1 1 auto;
      flex-wrap: nowrap;
      align-items: baseline;
      gap: var(--wa-space-2xs);
      overflow: hidden;
    }

    .summary-leading {
      display: inline-flex;
      align-items: center;
      flex: 0 0 auto;
    }

    .summary-trailing {
      display: inline-flex;
      align-items: center;
      flex: 0 0 auto;
      padding-inline-end: var(--wa-space-s);
    }

    .title {
      margin-right: 0.2rem;
      font-size: 1rem;
      font-weight: 650;
      color: var(--wa-color-text-normal);
      white-space: nowrap;
    }

    .subtitle {
      font-size: 0.8rem;
      color: var(--wa-color-text-quiet);
      min-width: 0;
      flex: 1 1 auto;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .panel {
      border-top: var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border);
      padding: var(--wa-space-m) var(--wa-space-l) var(--wa-space-l);
      display: grid;
      gap: var(--wa-space-m);
    }

    .description {
      margin: 0;
      color: var(--wa-color-text-quiet);
      font-size: 0.9rem;
    }

    .meta {
      margin: 0;
      display: grid;
      grid-template-columns: max-content 1fr;
      column-gap: var(--wa-space-s);
      row-gap: var(--wa-space-2xs);
    }

    .meta dt {
      margin: 0;
      color: var(--wa-color-text-quiet);
      font-size: 0.8rem;
    }

    .meta dd {
      margin: 0;
      font-size: 0.84rem;
      color: var(--wa-color-text-normal);
    }

    .tags {
      display: grid;
      gap: var(--wa-space-xs);
    }

    .tags-label {
      color: var(--wa-color-text-quiet);
      font-size: 0.8rem;
    }

    .tags-list {
      display: flex;
      flex-wrap: wrap;
      gap: var(--wa-space-2xs);
    }

    .tag {
      display: inline-flex;
      align-items: center;
      min-height: 1.5rem;
      border-radius: 999px;
      border: var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border);
      background: color-mix(in oklab, var(--wa-color-surface-lowered), #ffffff 8%);
      padding: 0 var(--wa-space-s);
      font-size: 0.76rem;
      color: var(--wa-color-text-quiet);
    }

    .panel-html {
      display: grid;
      gap: var(--wa-space-s);
    }

    :host(.identity-list-accordion) .identity-accordion-radio {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    :host(.identity-list-accordion) .identity-accordion-radio-input {
      margin: 0;
      inline-size: 1rem;
      block-size: 1rem;
      accent-color: var(--wa-color-brand-fill-loud);
      cursor: pointer;
    }

    :host(.identity-list-accordion) .identity-accordion-radio-input[disabled] {
      cursor: default;
      opacity: 0.95;
    }

    :host(.identity-list-accordion) .identity-accordion-panel {
      display: grid;
      gap: var(--wa-space-s);
    }

    :host(.identity-list-accordion) .wa-stack {
      display: flex;
      flex-direction: column;
      gap: 0;
      min-width: 0;
    }

    :host(.identity-list-accordion) .wa-cluster {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0;
      min-width: 0;
    }

    :host(.identity-list-accordion) .wa-align-items-center {
      align-items: center;
    }

    :host(.identity-list-accordion) .wa-gap-2xs {
      gap: var(--wa-space-2xs);
    }

    :host(.identity-list-accordion) .wa-gap-xs {
      gap: var(--wa-space-xs);
    }

    :host(.identity-list-accordion) .wa-gap-s {
      gap: var(--wa-space-s);
    }

    :host(.identity-list-accordion) .wa-caption-s {
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-xs);
      line-height: 1.35;
    }

    :host(.identity-list-accordion) .identity-item-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: var(--wa-space-2xs);
    }

    :host(.identity-list-accordion) .identity-detail-value {
      font-size: 0.95rem;
      font-weight: 600;
    }

    :host(.identity-list-accordion) .identity-detail-inline {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--wa-space-2xs);
      inline-size: 100%;
      max-inline-size: 100%;
      min-inline-size: 0;
    }

    :host(.identity-list-accordion) .identity-detail-inline > .identity-detail-value {
      inline-size: 100%;
      max-inline-size: 100%;
      min-inline-size: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    :host(.identity-list-accordion) .identity-detail-inline > wa-button,
    :host(.identity-list-accordion) .identity-detail-inline > wa-copy-button {
      flex: 0 0 auto;
    }

    :host(.identity-list-accordion) .identity-detail-did {
      font-family: "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 0.8rem;
      line-height: 1.45;
      word-break: break-all;
    }

    :host(.identity-list-accordion) .identity-details-loading {
      min-height: 6rem;
      display: grid;
      align-items: center;
    }

    :host(.identity-list-accordion) x-code {
      display: block;
    }

    :host(.identity-list-accordion) .meta dd {
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      word-break: normal;
      overflow-wrap: normal;
    }

    :host(.identity-list-accordion) .identity-detail-value.identity-detail-did {
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      word-break: normal;
      overflow-wrap: normal;
    }

    :host(.identity-list-accordion) wa-textarea::part(base) {
      inline-size: 100%;
    }

    :host(.identity-list-accordion) wa-callout::part(base) {
      width: 100%;
    }

    :host(.identity-list-accordion) wa-details::part(summary) {
      align-items: center;
    }
  `;

  constructor() {
    super();
    /** @type {XAccordionItem[]} */
    this.items = [];
    this.emptyText = 'No items found.';
    this.ariaLabel = 'Accordion list';
  }

  firstUpdated() {
    requestWebAwesomeDiscovery(this.renderRoot);
  }

  /**
   * @param {Map<string, unknown>} changedProperties
   */
  updated(changedProperties) {
    if (changedProperties.has('items')) {
      requestWebAwesomeDiscovery(this.renderRoot);
    }
  }

  /**
   * @param {MouseEvent} event
   */
  onInternalClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const actionElement = target.closest('[data-action]');
    if (!(actionElement instanceof HTMLElement)) {
      return;
    }

    if (actionElement instanceof HTMLInputElement && actionElement.disabled) {
      return;
    }

    if (actionElement.matches('input[type="radio"][data-action="switch"]')) {
      event.preventDefault();
    }

    this.dispatchEvent(new CustomEvent('x-accordion-action', {
      bubbles: true,
      composed: true,
      detail: {
        actionElement,
        action: actionElement.dataset.action ?? '',
        didUri: actionElement.dataset.didUri ?? '',
      },
    }));
  }

  /**
   * @param {Event} event
   */
  onItemToggle = (event) => {
    const currentTarget = event.currentTarget;
    if (!(currentTarget instanceof HTMLElement)) {
      return;
    }

    if (!isCurrentAccordionItemEvent(event, currentTarget)) {
      return;
    }

    const itemId = currentTarget.dataset.itemId ?? '';
    if (!itemId) {
      return;
    }

    const toggleEvent = /** @type {Event & { newState?: unknown }} */ (event);
    const isOpen = toggleEvent.newState === 'open'
      ? true
      : toggleEvent.newState === 'closed'
      ? false
      : event.target instanceof HTMLDetailsElement
      ? event.target.open
      : typeof currentTarget.open === 'boolean'
      ? currentTarget.open
      : currentTarget.hasAttribute('open');

    this.dispatchEvent(new CustomEvent('x-accordion-item-toggle', {
      bubbles: true,
      composed: true,
      detail: {
        itemId,
        open: isOpen,
      },
    }));
  };

  /**
   * @param {Event} event
   */
  onItemShow = (event) => {
    const currentTarget = event.currentTarget;
    if (!(currentTarget instanceof HTMLElement)) {
      return;
    }

    if (!isCurrentAccordionItemEvent(event, currentTarget)) {
      return;
    }

    const itemId = currentTarget.dataset.itemId ?? '';
    if (!itemId) {
      return;
    }

    this.dispatchEvent(new CustomEvent('x-accordion-item-show', {
      bubbles: true,
      composed: true,
      detail: { itemId },
    }));
  };

  /**
   * @param {Event} event
   */
  onItemHide = (event) => {
    const currentTarget = event.currentTarget;
    if (!(currentTarget instanceof HTMLElement)) {
      return;
    }

    if (!isCurrentAccordionItemEvent(event, currentTarget)) {
      return;
    }

    const itemId = currentTarget.dataset.itemId ?? '';
    if (!itemId) {
      return;
    }

    this.dispatchEvent(new CustomEvent('x-accordion-item-hide', {
      bubbles: true,
      composed: true,
      detail: { itemId },
    }));
  };

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
      <wa-details
        class="item"
        data-item-id=${item.id}
        ?open=${item.open === true}
        @wa-show=${this.onItemShow}
        @wa-hide=${this.onItemHide}
        @toggle=${this.onItemToggle}
      >
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
      <div class="list" role="list" aria-label=${this.ariaLabel} @click=${this.onInternalClick}>
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

/**
 * Returns true when the originating `<wa-details>` for the event is the same
 * accordion item we're currently handling. This avoids nested details panels
 * inside the item body from driving outer item open/close state.
 *
 * @param {Event} event
 * @param {HTMLElement} currentItem
 * @returns {boolean}
 */
function isCurrentAccordionItemEvent(event, currentItem) {
  if (typeof event.composedPath !== 'function') {
    return true;
  }

  const firstAccordionItemInPath = event.composedPath().find((pathNode) =>
    pathNode instanceof HTMLElement && pathNode.tagName.toLowerCase() === 'wa-details'
  );

  if (!(firstAccordionItemInPath instanceof HTMLElement)) {
    return true;
  }

  return firstAccordionItemInPath === currentItem;
}
