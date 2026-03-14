import { LitElement, css, html } from 'lit';
import { requestWebAwesomeDiscovery } from '../../utils/webawesome-loader.js';

/**
 * @typedef {HTMLElement & { update?: () => void }} SyntaxHighlightElementLike
 */

class XCode extends LitElement {
  static properties = {
    code: { attribute: false },
    language: { type: String },
    hideCopy: { attribute: 'hide-copy', type: Boolean },
    copyLabel: { attribute: 'copy-label', type: String },
    copiedLabel: { attribute: 'copied-label', type: String },
    errorLabel: { attribute: 'error-label', type: String },
  };

  static styles = css`
    :host {
      display: block;
      position: relative;
      animation-name: x-code-visibility-ping;
      animation-duration: 0.001s;
      animation-timing-function: linear;
      --x-code-toolbar-size: 2rem;
      --x-code-toolbar-offset: calc(var(--wa-space-xs) + var(--x-code-toolbar-size) + var(--wa-space-xs));
      --prettylights-bg: light-dark(#f6f8fa, #151b23);
      --prettylights-fg: light-dark(#1f2328, #f0f6fc);
      --prettylights-comment: light-dark(#59636e, #9198a1);
      --prettylights-constant: light-dark(#0550ae, #79c0ff);
      --prettylights-constant-other-reference-link: light-dark(#0a3069, #a5d6ff);
      --prettylights-entity: light-dark(#6639ba, #d2a8ff);
      --prettylights-entity-tag: light-dark(#0550ae, #7ee787);
      --prettylights-keyword: light-dark(#cf222e, #ff7b72);
      --prettylights-bold: light-dark(#f0f6fc, #f0f6fc);
      --prettylights-deleted-bg: light-dark(#ffebe9, #67060c);
      --prettylights-deleted-text: light-dark(#82071e, #ffdcd7);
      --prettylights-heading: light-dark(#0550ae, #1f6feb);
      --prettylights-inserted-bg: light-dark(#dafbe1, #033a16);
      --prettylights-inserted-text: light-dark(#116329, #aff5b4);
      --prettylights-italic: light-dark(#f0f6fc, #f0f6fc);
      --prettylights-string: light-dark(#0a3069, #a5d6ff);
      --prettylights-string-regexp: light-dark(#116329, #7ee787);
      --prettylights-variable: light-dark(#953800, #ffa657);
    }

    @keyframes x-code-visibility-ping {
      from {
        opacity: 0.999;
      }

      to {
        opacity: 1;
      }
    }

    .x-code-toolbar {
      position: absolute;
      top: var(--wa-space-xs);
      inset-inline-end: var(--wa-space-xs);
      z-index: 2;
    }

    .x-code-copy-button {
      --button-padding-inline: 0.4rem;
    }

    .x-code-copy-button::part(button) {
      border-radius: var(--wa-border-radius-s);
    }

    .x-code-source {
      display: none;
    }

    syntax-highlight {
      display: block;
      color-scheme: light dark;
      color: var(--prettylights-fg);
      font-family:
        ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New",
        monospace;
    }

    :host(.resolver-json-output) {
      margin: 0;
      border: var(--panel-border);
      border-radius: var(--wa-border-radius-m);
      background: var(--wa-color-surface-lowered);
      overflow: hidden;
    }

    :host(.resolver-json-output) syntax-highlight {
      margin: 0;
      max-width: 100%;
      overflow: auto;
      padding: var(--wa-space-m);
      font-size: 0.84rem;
      line-height: 1.45;
      white-space: pre;
    }

    ::highlight(comment),
    ::highlight(prolog),
    ::highlight(doctype),
    ::highlight(cdata) {
      color: var(--prettylights-comment);
    }

    ::highlight(keyword),
    ::highlight(rule) {
      color: var(--prettylights-keyword);
    }

    ::highlight(string),
    ::highlight(attr-value) {
      color: var(--prettylights-string);
    }

    ::highlight(number),
    ::highlight(atrule) {
      color: var(--prettylights-fg);
    }

    ::highlight(namespace) {
      opacity: 0.7;
    }

    ::highlight(constant),
    ::highlight(attr-name),
    ::highlight(char),
    ::highlight(builtin),
    ::highlight(operator) {
      color: var(--prettylights-constant);
    }

    ::highlight(property),
    ::highlight(tag),
    ::highlight(boolean),
    ::highlight(symbol) {
      color: var(--prettylights-entity-tag);
    }

    ::highlight(entity),
    ::highlight(selector),
    ::highlight(class-name),
    ::highlight(function) {
      color: var(--prettylights-entity);
    }

    ::highlight(variable) {
      color: var(--prettylights-variable);
    }

    ::highlight(regex) {
      font-weight: bold;
      color: var(--prettylights-string-regexp);
    }

    ::highlight(italic) {
      font-style: italic;
      color: var(--prettylights-italic);
    }

    ::highlight(bold) {
      font-weight: bold;
      color: var(--prettylights-bold);
    }

    ::highlight(deleted) {
      color: var(--prettylights-deleted-text);
      background-color: var(--prettylights-deleted-bg);
    }

    ::highlight(inserted) {
      color: var(--prettylights-inserted-text);
      background-color: var(--prettylights-inserted-bg);
    }

    ::highlight(url) {
      text-decoration: underline;
      color: var(--prettylights-constant-other-reference-link);
    }

    ::highlight(important) {
      color: var(--prettylights-heading);
    }

    ::highlight(css-important) {
      color: var(--prettylights-keyword);
    }

    ::highlight(md-title) {
      color: var(--prettylights-heading);
    }

    ::highlight(md-list) {
      color: var(--prettylights-variable);
    }
  `;

  constructor() {
    super();
    this.code = '';
    this.language = 'plaintext';
    this.hideCopy = false;
    this.copyLabel = 'Copy';
    this.copiedLabel = 'Copied';
    this.errorLabel = 'Copy failed';
    this.onVisibilityAnimationStart = this.onVisibilityAnimationStart.bind(this);
    this.onSourceSlotChange = this.onSourceSlotChange.bind(this);
    this.addEventListener('animationstart', this.onVisibilityAnimationStart);
  }

  connectedCallback() {
    super.connectedCallback();
    this.refreshSyntaxHighlight();
  }

  updated(changedProperties) {
    if (changedProperties.has('code')) {
      this.syncCopyButtonValue();
      this.syncSyntaxHighlightContent();
      this.refreshSyntaxHighlight();
    }

    if (changedProperties.has('language')) {
      this.syncSyntaxHighlightContent();
      this.refreshSyntaxHighlight();
    }

    if (changedProperties.has('hideCopy')) {
      requestWebAwesomeDiscovery(this.renderRoot);
    }
  }

  firstUpdated() {
    requestWebAwesomeDiscovery(this.renderRoot);
    this.syncCopyButtonValue();
    this.syncSyntaxHighlightContent();
    this.refreshSyntaxHighlight();
  }

  refreshSyntaxHighlight() {
    const syntaxHighlight = this.renderRoot.querySelector('syntax-highlight');
    if (!(syntaxHighlight instanceof HTMLElement)) {
      return;
    }

    const highlightElement = /** @type {SyntaxHighlightElementLike} */ (syntaxHighlight);
    if (typeof highlightElement.update === 'function') {
      highlightElement.update();
    }
  }

  /**
   * @param {AnimationEvent} event
   */
  onVisibilityAnimationStart(event) {
    if (event.target !== this) {
      return;
    }

    if (event.animationName !== 'x-code-visibility-ping') {
      return;
    }

    this.refreshSyntaxHighlight();
  }

  onSourceSlotChange() {
    this.syncCopyButtonValue();
    this.syncSyntaxHighlightContent();
    this.refreshSyntaxHighlight();
  }

  getEffectiveCode() {
    if (typeof this.code === 'string' && this.code.length > 0) {
      return this.code;
    }

    const sourceSlot = this.renderRoot.querySelector('.x-code-source');
    if (!(sourceSlot instanceof HTMLSlotElement)) {
      return this.textContent ?? '';
    }

    const assignedNodes = sourceSlot.assignedNodes({ flatten: true });
    if (assignedNodes.length === 0) {
      return this.textContent ?? '';
    }

    return assignedNodes.map((node) => node.textContent ?? '').join('');
  }

  syncCopyButtonValue() {
    const copyButton = this.renderRoot.querySelector('.x-code-copy-button');
    if (!(copyButton instanceof HTMLElement)) {
      return;
    }

    const copyButtonWithValue = /** @type {HTMLElement & { value?: string }} */ (copyButton);
    copyButtonWithValue.value = this.getEffectiveCode();
  }

  syncSyntaxHighlightContent() {
    const syntaxHighlight = this.renderRoot.querySelector('syntax-highlight');
    if (!(syntaxHighlight instanceof HTMLElement)) {
      return;
    }

    const nextCode = this.getEffectiveCode();
    if (syntaxHighlight.textContent !== nextCode) {
      syntaxHighlight.textContent = nextCode;
    }
  }

  render() {
    return html`
      ${this.hideCopy
        ? ''
        : html`
            <div class="x-code-toolbar">
              <wa-copy-button
                class="x-code-copy-button"
                copy-label=${this.copyLabel}
                success-label=${this.copiedLabel}
                error-label=${this.errorLabel}></wa-copy-button>
            </div>
          `}

      <slot class="x-code-source" @slotchange=${this.onSourceSlotChange}></slot>
      <syntax-highlight language=${this.language}></syntax-highlight>
    `;
  }
}

if (!customElements.get('x-code')) {
  customElements.define('x-code', XCode);
}
