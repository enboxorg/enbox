import { LitElement, css, html } from 'lit';
import { createRef, ref } from 'lit/directives/ref.js';
import { requestWebAwesomeDiscovery } from '../../utils/webawesome-loader.js';

const keypadLayout = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['clear', '0', 'delete'],
];

class PinPad extends LitElement {
  static properties = {
    value: { type: String },
    disabled: { type: Boolean, reflect: true },
    focused: { type: Boolean, reflect: true },
    helperText: { type: String, attribute: 'helper-text' },
    minLength: { type: Number, attribute: 'min-length' },
    maxLength: { type: Number, attribute: 'max-length' },
  };

  static styles = css`
    :host {
      display: block;
      color: var(--wa-color-text-normal);
    }

    .pin-pad {
      display: grid;
      gap: 0.9rem;
    }

    .pin-display {
      display: grid;
      justify-items: center;
      gap: 0.35rem;
      padding-block: var(--wa-space-xs);
      text-align: center;
    }

    .pin-display-value {
      min-block-size: 2.4rem;
      color: var(--wa-color-text-normal);
      font-family: var(--wa-font-family-code, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
      font-size: clamp(1.8rem, 4vw, 2.4rem);
      font-weight: 700;
      letter-spacing: 0.18em;
      line-height: 1.2;
      word-break: break-all;
    }

    .pin-display-copy {
      color: var(--wa-color-text-quiet);
      font-size: 0.88rem;
      font-weight: 600;
    }

    .keypad {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.65rem;
    }
  `;

  constructor() {
    super();
    this.value = '';
    this.disabled = false;
    this.focused = false;
    this.helperText = 'Enter 4 to 8 digits';
    this.minLength = 4;
    this.maxLength = 8;
    this.firstKeyRef = createRef();
    this._isKeyboardListening = false;
    this.onWindowKeydown = this.onWindowKeydown.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    this.syncKeyboardCapture();
  }

  firstUpdated() {
    requestWebAwesomeDiscovery(this.renderRoot);
  }

  disconnectedCallback() {
    this.detachKeyboardCapture();
    super.disconnectedCallback();
  }

  updated(changedProperties) {
    if (changedProperties.has('focused') || changedProperties.has('disabled')) {
      this.syncKeyboardCapture();
    }
  }

  focusPrimaryKey() {
    focusFieldSoon(this.firstKeyRef.value);
  }

  get canSubmit() {
    return this.value.length >= this.minLength && this.value.length <= this.maxLength;
  }

  syncKeyboardCapture() {
    if (this.focused && !this.disabled) {
      if (!this._isKeyboardListening) {
        window.addEventListener('keydown', this.onWindowKeydown);
        this._isKeyboardListening = true;
      }
      return;
    }

    this.detachKeyboardCapture();
  }

  detachKeyboardCapture() {
    if (!this._isKeyboardListening) {
      return;
    }

    window.removeEventListener('keydown', this.onWindowKeydown);
    this._isKeyboardListening = false;
  }

  onWindowKeydown(event) {
    if (!this.focused || this.disabled || !this.isVisibleForKeyboardCapture()) {
      return;
    }

    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    if (isEditableTarget(event.target)) {
      return;
    }

    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      this.focusKey(event.key);
      this.appendDigit(event.key);
      return;
    }

    if (event.key === 'Backspace') {
      event.preventDefault();
      this.focusKey('delete');
      this.deleteDigit();
      return;
    }

    if (event.key === 'Delete' || event.key === 'Escape') {
      event.preventDefault();
      this.focusKey('clear');
      this.clearValue();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (this.canSubmit) {
        this.dispatchSubmit();
      }
      return;
    }
  }

  isVisibleForKeyboardCapture() {
    if (this.hidden) {
      return false;
    }

    return this.getClientRects().length > 0;
  }

  appendDigit(digit) {
    if (this.disabled || this.value.length >= this.maxLength) {
      return;
    }

    this.commitValue(`${this.value}${digit}`);
  }

  clearValue() {
    if (this.disabled || this.value.length === 0) {
      return;
    }

    this.commitValue('');
  }

  deleteDigit() {
    if (this.disabled || this.value.length === 0) {
      return;
    }

    this.commitValue(this.value.slice(0, -1));
  }

  commitValue(value) {
    this.value = value;
    this.dispatchEvent(new CustomEvent('pin-input', {
      detail: { value },
      bubbles: true,
      composed: true,
    }));
  }

  renderKey(key, index) {
    const label = key === 'clear'
      ? 'Clear'
      : key === 'delete'
      ? 'Delete'
      : key;
    const keyRef = index === 0 ? ref(this.firstKeyRef) : null;

    const onClick = (event) => {
      this.focusButton(event.currentTarget);

      if (key === 'clear') {
        this.clearValue();
        return;
      }

      if (key === 'delete') {
        this.deleteDigit();
        return;
      }

      this.appendDigit(key);
    };

    return html`
      <wa-button
        ${keyRef}
        data-key=${key}
        type="button"
        appearance="outlined"
        size="large"
        ?disabled=${this.disabled}
        aria-label=${label}
        @click=${onClick}
      >
        ${label}
      </wa-button>
    `;
  }

  render() {
    const displayValue = this.value.slice(0, this.maxLength);

    return html`
      <div class="pin-pad">
        <div class="pin-display" role="status" aria-live="polite" aria-label="PIN entry display">
          <div class="pin-display-value">
            ${displayValue || '\u00a0'}
          </div>
          <div class="pin-display-copy">${this.helperText || 'Enter 4 to 8 digits'}</div>
        </div>

        <div class="keypad" role="group" aria-label="PIN keypad">
          ${keypadLayout.flat().map((key, index) => this.renderKey(key, index))}
        </div>
      </div>
    `;
  }

  focusKey(key) {
    const button = this.renderRoot.querySelector(`wa-button[data-key="${key}"]`);
    this.focusButton(button);
  }

  focusButton(button) {
    if (!(button instanceof HTMLElement)) {
      return;
    }

    focusFieldSoon(button);
  }

  dispatchSubmit() {
    this.dispatchEvent(new CustomEvent('pin-submit', {
      detail: { value: this.value },
      bubbles: true,
      composed: true,
    }));
  }
}

if (!customElements.get('pin-pad')) {
  customElements.define('pin-pad', PinPad);
}

/**
 * @param {HTMLElement | null | undefined} field
 */
function focusFieldSoon(field) {
  if (!(field instanceof HTMLElement)) {
    return;
  }

  queueMicrotask(() => {
    if (typeof field.focus === 'function') {
      field.focus();
    }
  });
}

/**
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
function isEditableTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }

  return target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') !== null;
}
