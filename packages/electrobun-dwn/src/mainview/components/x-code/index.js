import { LitElement, html } from 'lit';
import { adoptComponentStyle } from '../style-registry.js';

/**
 * @typedef {HTMLElement & { update?: () => void }} SyntaxHighlightElementLike
 */

const componentStylesheetUrl = new URL(
  import.meta.url.includes('/components/x-code/')
    ? './index.css'
    : './components/x-code/index.css',
  import.meta.url,
);

class XCode extends LitElement {
  static properties = {
    code: { attribute: false },
    language: { type: String },
    hideCopy: { attribute: 'hide-copy', type: Boolean },
    copyLabel: { attribute: 'copy-label', type: String },
    copiedLabel: { attribute: 'copied-label', type: String },
    errorLabel: { attribute: 'error-label', type: String },
  };

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

  createRenderRoot() {
    const root = super.createRenderRoot();
    void adoptComponentStyle('x-code', componentStylesheetUrl, root).catch((error) => {
      console.error('Failed to adopt x-code styles', error);
    });
    return root;
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
  }

  firstUpdated() {
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
