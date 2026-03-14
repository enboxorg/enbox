import { LitElement, css, html } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import { createHashvatar } from 'hashvatar';

const DEFAULT_SIZE = 36;
const MIN_SIZE = 16;
const MAX_SIZE = 512;

/**
 * @param {number} value
 * @returns {number}
 */
function clampSize(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_SIZE;
  }

  const rounded = Math.round(value);
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, rounded));
}

/**
 * @param {string} value
 * @returns {string}
 */
function toInitials(value) {
  const text = value.trim();
  if (!text) {
    return '?';
  }

  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    return `${tokens[0][0] ?? ''}${tokens[1][0] ?? ''}`.toUpperCase();
  }

  return text.slice(0, 2).toUpperCase();
}

class HashAvatar extends LitElement {
  static properties = {
    hash: { type: String },
    initials: { type: String },
    label: { type: String },
    mode: { type: String },
    size: { type: Number },
    imageDataUrl: { state: true },
  };

  static styles = css`
    :host {
      display: inline-block;
      inline-size: 100%;
      block-size: 100%;
      min-inline-size: 0;
    }

    wa-avatar {
      inline-size: 100%;
      block-size: 100%;
    }
  `;

  constructor() {
    super();
    this.hash = '';
    this.initials = '';
    this.label = '';
    this.mode = 'dither';
    this.size = DEFAULT_SIZE;
    this.imageDataUrl = '';
  }

  /**
   * @param {Map<PropertyKey, unknown>} changedProperties
   */
  updated(changedProperties) {
    if (changedProperties.has('hash') || changedProperties.has('mode') || changedProperties.has('size')) {
      this.generateAvatarImage();
    }
  }

  generateAvatarImage() {
    const hashValue = this.hash.trim();
    if (!hashValue) {
      this.imageDataUrl = '';
      return;
    }

    const normalizedMode = this.mode === 'dither' ? 'dither' : 'gradient';

    try {
      const result = createHashvatar({
        hash: hashValue,
        mode: normalizedMode,
        size: clampSize(this.size),
      });

      this.imageDataUrl = result.canvas.toDataURL('image/png');
      result.destroy();
    } catch (error) {
      this.imageDataUrl = '';
      console.warn('Failed to generate hash avatar image.', error);
    }
  }

  get fallbackInitials() {
    const providedInitials = this.initials.trim();
    if (providedInitials) {
      return providedInitials.slice(0, 2).toUpperCase();
    }

    return toInitials(this.hash);
  }

  get computedLabel() {
    const providedLabel = this.label.trim();
    if (providedLabel) {
      return providedLabel;
    }

    return this.hash.trim()
      ? `Generated avatar for ${this.hash.trim()}`
      : 'Generated avatar';
  }

  render() {
    return html`
      <wa-avatar
        label=${this.computedLabel}
        initials=${this.fallbackInitials}
        image=${ifDefined(this.imageDataUrl || undefined)}
      ></wa-avatar>
    `;
  }
}

if (!customElements.get('hash-avatar')) {
  customElements.define('hash-avatar', HashAvatar);
}
