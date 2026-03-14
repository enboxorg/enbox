import { LitElement, css, html } from 'lit';
import { createRef, ref } from 'lit/directives/ref.js';
import '../pin-pad/index.js';
import { requestWebAwesomeDiscovery } from '../../utils/webawesome-loader.js';

class IdentityCreateWizard extends LitElement {
  static properties = {
    mode: { type: String },
    busy: { type: Boolean, reflect: true },
    step: { state: true },
    name: { state: true },
    endpointsText: { state: true },
    pin: { state: true },
  };

  static styles = css`
    :host {
      display: block;
    }

    form {
      display: grid;
      gap: var(--wa-space-m);
      min-inline-size: 0;
    }

    .copy {
      color: var(--wa-color-text-quiet);
      font-size: 0.95rem;
      line-height: 1.45;
    }

    .panel {
      display: grid;
      gap: var(--wa-space-s);
      min-inline-size: 0;
    }

    wa-input,
    wa-textarea {
      inline-size: 100%;
      max-inline-size: 100%;
      min-inline-size: 0;
    }

    .pin-stage {
      display: grid;
      gap: var(--wa-space-s);
    }
  `;

  constructor() {
    super();
    this.mode = 'additional';
    this.busy = false;
    this.step = 0;
    this.name = '';
    this.endpointsText = '';
    this.pin = '';

    this.nameInputRef = createRef();
    this.pinPadRef = createRef();
  }

  get requiresPinStep() {
    return this.mode === 'initial' || this.mode === 'unlock';
  }

  get trimmedName() {
    return this.name.trim();
  }

  get canContinueFromDetails() {
    return this.trimmedName.length > 0;
  }

  get pinIsValid() {
    return isValidVaultPin(this.pin);
  }

  reset(options = {}) {
    if (typeof options.mode === 'string' && options.mode.length > 0) {
      this.mode = options.mode;
    }

    this.step = 0;
    this.name = '';
    this.endpointsText = '';
    this.pin = '';
  }

  focusPrimaryField() {
    void this.updateComplete.then(() => {
      if (this.requiresPinStep && this.step === 1) {
        this.pinPadRef.value?.focusPrimaryKey?.();
        return;
      }

      focusFieldSoon(this.nameInputRef.value);
    });
  }

  firstUpdated() {
    requestWebAwesomeDiscovery(this.renderRoot);
    this.emitWizardState();
  }

  updated(changedProperties) {
    if (
      changedProperties.has('mode')
      || changedProperties.has('busy')
      || changedProperties.has('step')
      || changedProperties.has('name')
      || changedProperties.has('pin')
    ) {
      this.emitWizardState();
    }
  }

  getFooterState() {
    return {
      requiresPinStep: this.requiresPinStep,
      step: this.step,
      canContinueFromDetails: this.canContinueFromDetails,
      pinIsValid: this.pinIsValid,
      busy: this.busy,
    };
  }

  requestPrimaryAction() {
    if (this.busy) {
      return;
    }

    const form = this.renderRoot.querySelector('form');
    if (form instanceof HTMLFormElement) {
      form.requestSubmit();
    }
  }

  requestBackAction() {
    if (this.busy || this.step !== 1) {
      return;
    }

    this.onBackToDetails();
  }

  emitWizardState() {
    this.dispatchEvent(new CustomEvent('wizard-state-change', {
      detail: this.getFooterState(),
      bubbles: true,
      composed: true,
    }));
  }

  render() {
    return html`
      <form @submit=${this.onFormSubmit}>
        ${this.requiresPinStep && this.step === 1
          ? this.renderPinStep()
          : this.renderDetailsStep()}
      </form>
    `;
  }

  renderDetailsStep() {
    return html`
      <section class="panel">
        <div class="copy">
          ${this.mode === 'initial'
            ? 'Add a name for your first DID. You can also include DWN endpoints before you choose a vault PIN.'
            : this.mode === 'unlock'
            ? 'Add a name for the DID, then enter your existing vault PIN to create it.'
            : 'This DID will be added to the current vault.'}
        </div>

        <wa-input
          ${ref(this.nameInputRef)}
          label="Name"
          placeholder="Identity name"
          required
          .value=${this.name}
          @input=${this.onNameInput}
        ></wa-input>

        <wa-textarea
          label="DWN endpoints (optional)"
          placeholder="One endpoint per line"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          .value=${this.endpointsText}
          @input=${this.onEndpointsInput}
        ></wa-textarea>
      </section>
    `;
  }

  renderPinStep() {
    return html`
      <section class="panel">
        <div class="pin-stage">
          <pin-pad
            ${ref(this.pinPadRef)}
            .value=${this.pin}
            .disabled=${this.busy}
            .helperText=${this.mode === 'initial' ? 'Choose a 4 to 8 digit PIN' : 'Enter your 4 to 8 digit PIN'}
            ?focused=${true}
            min-length="4"
            max-length="8"
            @pin-input=${this.onPinPadInput}
            @pin-submit=${this.onPinPadSubmit}
          ></pin-pad>
        </div>
      </section>
    `;
  }

  onNameInput = (event) => {
    this.name = readControlValue(event.target);
  };

  onEndpointsInput = (event) => {
    this.endpointsText = readControlValue(event.target);
  };

  onPinPadInput = (event) => {
    const value = event.detail?.value ?? '';
    this.pin = value;
  };

  onPinPadSubmit = () => {
    if (this.busy || !this.pinIsValid) {
      return;
    }

    const form = this.renderRoot.querySelector('form');
    if (form instanceof HTMLFormElement) {
      form.requestSubmit();
    }
  };

  onBackToDetails = () => {
    this.step = 0;
    void this.updateComplete.then(() => {
      focusFieldSoon(this.nameInputRef.value);
    });
  };

  onFormSubmit = (event) => {
    event.preventDefault();
    if (this.busy) {
      return;
    }

    if (!this.requiresPinStep) {
      if (!this.canContinueFromDetails) {
        focusFieldSoon(this.nameInputRef.value);
        return;
      }

      this.emitCreate();
      return;
    }

    if (this.step === 0) {
      if (!this.canContinueFromDetails) {
        focusFieldSoon(this.nameInputRef.value);
        return;
      }

      this.step = 1;
      void this.updateComplete.then(() => {
        this.pinPadRef.value?.focusPrimaryKey?.();
      });
      return;
    }

    if (!this.pinIsValid) {
      return;
    }

    this.emitCreate();
  };

  emitCreate() {
    if (!this.canContinueFromDetails) {
      focusFieldSoon(this.nameInputRef.value);
      return;
    }

    this.dispatchEvent(new CustomEvent('create-submit', {
      detail: {
        name: this.trimmedName,
        dwnEndpoints: parseEndpointText(this.endpointsText),
        password: this.requiresPinStep ? this.pin : undefined,
      },
      bubbles: true,
      composed: true,
    }));
  }
}

if (!customElements.get('identity-create-wizard')) {
  customElements.define('identity-create-wizard', IdentityCreateWizard);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isValidVaultPin(value) {
  return /^[0-9]{4,8}$/.test(value);
}

/**
 * @param {unknown} target
 * @returns {string}
 */
function readControlValue(target) {
  if (!target || typeof target !== 'object') {
    return '';
  }

  const value = /** @type {{ value?: unknown }} */ (target).value;
  return typeof value === 'string' ? value : '';
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function parseEndpointText(value) {
  return Array.from(new Set(
    String(value)
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  ));
}

/**
 * @param {HTMLElement | null | undefined} field
 */
function focusFieldSoon(field) {
  if (!(field instanceof HTMLElement)) {
    return;
  }

  const tryFocus = () => {
    const control = /** @type {{ focus?: () => void; setFocus?: () => Promise<void> | void }} */ (field);
    if (typeof control.setFocus === 'function') {
      void control.setFocus();
      return;
    }

    if (typeof control.focus === 'function') {
      control.focus();
    }
  };

  queueMicrotask(() => {
    tryFocus();
    window.requestAnimationFrame(() => tryFocus());
    window.setTimeout(() => tryFocus(), 100);
  });
}
